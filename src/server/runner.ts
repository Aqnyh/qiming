/**
 * src/server/runner.ts —— 运行宿主：把"一次提问"跑成一次完整的智能体运行。
 *
 * 需求 7 的落点：前端只发一个请求，后端自己开循环；浏览器关掉运行照样跑完并落盘。
 * 顺序：建会话 → 落用户消息 → 组装提示词 → （必要时压缩）→ 循环 → 边跑边落盘边广播 → 收尾。
 *
 * 三个纪律（旧项目的血泪）：
 *  1. **先落盘再广播结束**：end 事件到客户端时，会话文件里已经有完整结果，刷新不丢；
 *  2. **落盘节流但不推迟收尾**：跑动中每 1.5 秒落一次，收尾时无条件落；
 *  3. **停止是可打断的**：AbortController 一路传进 provider 与工具，停止后不再产生新调用。
 */
import { chat as providerChat } from '../providers/index.ts';
import type { ChatMessage, ProviderConfig } from '../providers/types.ts';
import { runLoop } from '../agent/loop.ts';
import type { LoopNotice } from '../agent/loop.ts';
import { resolveMainRounds, resolveSubRounds } from '../agent/rounds.ts';
import { createToolExecutor } from '../agent/tools.ts';
import { assembleSystem } from '../agent/prompt.ts';
import { collectText, compactRange, estimateMessages, needsCompaction, normalizeCompact, summarize, usageOf } from '../agent/context.ts';
import { addCompactNode, deriveCompact } from '../store/session-log.ts';
import { encoderFor } from '../agent/count.ts';
import { maybeSpill, spillConfigFrom } from '../agent/spill.ts';
import { appendMessage, getSession, newMessage, newSession, putSession, replaceMessage, insertMessage, touchTitle, writeSessions, readSessions } from '../store/sessions.ts';
import type { CallRecord, Message, Session } from '../store/sessions.ts';
import { findProject, cwdOf } from '../store/projects.ts';
import { readSettings, providerOf } from '../store/settings.ts';
import { indexLines as memoryIndex } from '../modules/memory/index.ts';
import { indexLines as skillIndex } from '../modules/skills/index.ts';
import { osUser, osHome } from '../util/paths.ts';
import { repoFor, forgetRepo } from '../store/checkpoints.ts';
import { logger } from '../util/log.ts';
import { createJournal } from './journal.ts';
import type { RunEvent } from './journal.ts';
import type { Run, SteerMode } from './run-types.ts';
import { MAX_KEEP_EVENTS } from './run-types.ts';

const log = logger('run');

export type RunnerDeps = {
  /** 取走排队队列（会话级，注册表持有）：按语义模式取；返回的条目会被落成会话消息 */
  takeQueued: (sessionId: string, mode: SteerMode) => Array<{ id: string; text: string; ts: number; mode: SteerMode }>;
  queueOf: (sessionId: string) => Array<{ id: string; text: string; ts: number; mode: SteerMode }>;
  plugins: ReturnType<typeof import('../modules/plugins/registry.ts').createPluginRegistry>;
  prompts: ReturnType<typeof import('../modules/prompts/registry.ts').createPromptRegistry>;
  resources: ReturnType<typeof import('../modules/resources/index.ts').createResourceRegistry>;
  sudoPassword: () => string;
  /** 由注册表提供的子运行入口 */
  spawnSubRun: (parent: Run, task: string, opts: { tools?: string[]; readOnly?: boolean; maxRounds?: number }) => Promise<{ ok: boolean; text: string; runId: string; id?: string }>;
  /** 子智能体控制面（列表/续谈/中断）：由注册表提供 */
  subagentCtrl: NonNullable<import('../modules/plugins/types.ts').ToolRunCtx['subagents']>;
};

export type StartInput = {
  sessionId: string;
  text: string;
  providerId?: string | null;
  /** 界面上"停止"用不到这里；这是内部用（子智能体复用同一函数） */
  isSub?: boolean;
  /**
   * 子智能体**续谈**时复用的内存会话（连同它的消息历史）。
   * 不传 = 新建一条临时会话（首次 spawn_agent）。见 runs.ts 的 subagents 控制面。
   */
  subSession?: Session;
};

export async function executeRun(run: Run, input: StartInput, deps: RunnerDeps): Promise<void> {
  const journal = createJournal(run.id);
  const emit = (ev: RunEvent): void => {
    run.events.push(ev);
    if (run.events.length > MAX_KEEP_EVENTS) run.events.splice(0, run.events.length - MAX_KEEP_EVENTS);
    journal.append(ev);
    for (const fn of run.listeners) {
      try {
        fn(ev);
      } catch {
        /* 单个订阅者出错不影响运行 */
      }
    }
    run.emitted += 1;
  };

  /**
   * 本次运行累计收到的浅文字提示（循环注入的）。
   *
   * 为什么要单独攒一份：这些提示此前只发进事件流（浏览器里的流式缓冲），
   * 刷新/换设备/运行结束后就没了。而插话**不画气泡**，提示是它唯一的呈现 ——
   * 所以必须落进助手消息的 notices 里长期留着。
   */
  const notices: string[] = [];

  let session: Session | null = null;
  try {
    // 子智能体的会话是**临时**的：只活在内存里，绝不写进用户的会话文件。
    // 续谈（subSession）时复用它自己的历史，于是"接着上次的结论继续问"可行。
    session = input.isSub
      ? (input.subSession ?? newSession({ projectId: run.projectId, providerId: input.providerId ?? null }))
      : (getSession(run.sessionId) ?? putSession(newSession({ projectId: run.projectId })));
    run.sessionId = session.id;
    const settings = readSettings();
    const provider =
      providerOf(settings, input.providerId ?? session.providerId) ?? providerOf(settings, settings.activeId);
    if (!provider) throw new Error('还没有配置模型服务商：打开「设置 → 模型」加一个（Base URL + 模型名 + Key）。');

    const project = findProject(session.projectId ?? run.projectId);
    const cwd = cwdOf(project, osHome());

    /* 1) 用户消息（走 append-only 日志：msgs 由日志重放得到） */
    const userMsg = newMessage('user', input.text, { ...(input.isSub ? { steer: false } : {}) });
    appendMessage(session, userMsg);
    if (!input.isSub) touchTitle(session, input.text);
    session.providerId = provider.id;
    session.model = provider.model;
    if (!input.isSub) {
      putSession(session);
      emit({ type: 'msg', runId: run.id, sessionId: session.id, msg: userMsg });
    }

    /* 2) 助手消息占位（正文与调用摘要边跑边填） */
    const asst = newMessage('assistant', '', { runId: run.id });
    const calls: CallRecord[] = [];
    asst.calls = calls;
    asst.runId = run.id;
    // 先声明"这一段开始了"：界面刷新/重连时据此把流式消息接管过来
    emit({
      type: 'run_started',
      runId: run.id,
      sessionId: session.id,
      msgId: asst.id,
      ts: Date.now(),
      title: session.title,
      ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
      ...(run.task ? { task: run.task } : {}),
    });
    // 占位也进日志：这样"这一段开始了"这件事本身可重放（收尾时再 replace 定稿）
    appendMessage(session, asst);

    const providerCfg: ProviderConfig = {
      ...provider,
      sessionId: session.id,
      extraBody: { ...(provider.extraBody ?? {}), ...(settings.params.echoThinking ? { echo_thinking: true } : {}) },
    };

    /* 3) 系统提示词 */
    const systemOf = (): string =>
      assembleSystem({
        prompts: deps.prompts,
        plugins: deps.plugins.views().filter((p) => !deps.resources.get(p.id)),
        resources: deps.resources.views().map((r) => ({
          name: r.name,
          desc: r.desc,
          state: r.status.state,
          detail: r.status.detail,
          tools: r.toolList.map((t) => t.name),
        })),
        memory: {
          global: memoryIndex({ kind: 'global' }),
          project: project ? memoryIndex({ kind: 'project', id: project.id, name: project.name }) : null,
          projectName: project?.name,
        },
        skills: skillIndex(),
        env: {
          user: osUser(),
          cwd,
          projectName: project?.name,
          model: provider.model,
          provider: provider.name,
          now: new Date().toLocaleString('zh-CN'),
        },
      });

    /* 4) 请求视图（跨轮只带用户话与助手正文；工具原文不跨轮）。
       slice(0,-2) 去掉本轮的"用户消息 + 助手占位"，再把这轮的提问作为最后一条补回来。
       子智能体续谈（subSession）走同一套：它的历史就是它自己那几条消息。 */
    const history: ChatMessage[] = toRequestMessages(session.msgs.slice(0, -2));
    history.push({ role: 'user', content: input.text });

    let system = systemOf();
    const ctxLimit = settings.params.ctxLimit ?? 0;
    /** 预留的输出空间：没配 maxTokens 就按 8k 算 —— 这一块也得从"剩余"里扣掉 */
    const reserve = Math.max(0, Math.trunc(Number(settings.params.maxTokens ?? 8192) || 8192));
    /* 6) 工具执行器（含子智能体入口）—— 先建，因为"开销"里要算工具表 */
    /* 文件改动的检查点仓库：每条会话一棵影子 git 树（见 store/checkpoints.ts）。
       写文件的工具会拿它"动手前打一笔"，changes 插件用它列改动 / 看 diff / 撤回。 */
    const ckRepo = repoFor(session.id, cwd);
    const executor = createToolExecutor({
      plugins: deps.plugins,
      prompts: deps.prompts,
      runId: run.id,
      sessionId: session.id,
      cwd,
      project,
      signal: run.controller.signal,
      log,
      sudoPassword: deps.sudoPassword,
      runSubagent: (task, opts) => deps.spawnSubRun(run, task, opts),
      subagents: deps.subagentCtrl,
      changes: ckRepo
        ? {
            snapshot: async (label, files) => {
              const cp = await ckRepo.snapshot(label, files);
              // 有改动就广播：界面上的"改动清单"立刻能看到新的一条
              if (cp) emit({ type: 'checkpoint', runId: run.id, sessionId: session!.id, msgId: asst.id, checkpoint: { id: cp.id, label: cp.label, files: cp.files } });
              return cp ? { id: cp.id, label: cp.label } : null;
            },
            list: () => ckRepo.list(),
            diff: (id) => ckRepo.diff(id),
            show: (id, file) => ckRepo.show(id, file),
            restore: async (id) => {
              const r = await ckRepo.restore(id);
              if (r.ok) emit({ type: 'checkpoint', runId: run.id, sessionId: session!.id, msgId: asst.id, checkpoint: { id, label: `撤回 → ${id}`, files: r.files, restored: true } });
              return r;
            },
          }
        : undefined,
    });

    /**
     * 工具表的 token 数。**这块最容易漏算**：几十个工具的 schema 每轮都随请求发出去，
     * 动辄几千 token。用真分词算，并按"名字+描述长度"做键缓存（只有工具表变过才重算）。
     */
    let toolTableCache: { key: string; tokens: number } | null = null;
    const toolTableTokens = (): number => {
      const tools = executor.toolDefs();
      const key = `${tools.length}:${tools.reduce((n, t) => n + t.name.length + t.description.length, 0)}`;
      if (!toolTableCache || toolTableCache.key !== key) {
        const { count } = encoderFor(provider.model);
        let n = 0;
        for (const t of tools) {
          n += count(t.name) + count(t.description) + count(JSON.stringify(t.schema ?? {})) + 2;
        }
        toolTableCache = { key, tokens: n };
      }
      return toolTableCache.tokens;
    };

    /** 开销 = 系统提示词 + 工具表 + 预留输出（压缩阈值与界面显示共用这一个口径） */
    const overhead = (): number =>
      estimateMessages([{ role: 'system', content: system }], provider.model) + toolTableTokens() + reserve;

    /** 当前请求视图的占用分解：广播给界面（顶栏那个上下文环） */
    const emitUsage = (msgs: ChatMessage[], round: number): void => {
      emit({
        type: 'usage',
        runId: run.id,
        sessionId: session!.id,
        msgId: asst.id,
        round,
        usage: usageOf({
          messages: msgs,
          system,
          tools: executor.toolDefs(),
          ctxLimit,
          reserve,
          model: provider.model,
        }),
      });
    };

    /* 5) 压缩（超阈值才做，失败不影响本次运行）。
       每次压缩产出**一个替换节点**（声明式记录被遮蔽的区间），追加到 session.compact.nodes ——
       原文仍留在 session.msgs 里可审计，请求视图只在这一层替换（见 agent/context.ts）。 */
    if (
      !input.isSub &&
      ctxLimit > 0 &&
      needsCompaction({
        messages: history,
        compact: normalizeCompact(session.compact),
        overheadTokens: overhead(),
        ctxLimit,
        compactHeader: '',
        model: provider.model,
      })
    ) {
      const range = compactRange(history, 6, normalizeCompact(session.compact));
      if (range) {
        try {
          const complete = async (cfg: ProviderConfig, msgs: ChatMessage[], opts: { signal?: AbortSignal }) =>
            collectText(providerChat(cfg, msgs, { ...opts, params: { ...settings.params, thinkingBudget: 0 } }));
          const text = await summarize(history.slice(range.from, range.to), deps.prompts.text('compact.prompt'), complete, providerCfg, run.controller.signal);
          if (text) {
            const node = {
              id: `c_${Date.now().toString(36)}`,
              from: range.from,
              to: range.to,
              text,
              ts: Date.now(),
            };
            // 压缩节点也走 append-only 日志（可重放、可撤回，见 store/session-log.ts）
            addCompactNode(session.log ?? (session.log = []), node);
            session.compact = { nodes: deriveCompact(session.log) };
            putSession(session);
            log.info('已压缩上下文', { from: range.from, to: range.to, nodes: session.compact.nodes.length });
          }
        } catch (err) {
          log.warn('压缩失败，按原文继续', { err: String(err) });
        }
      }
    }

    const budgetRounds = Math.max(
      4,
      deps.plugins
        .views()
        .filter((p) => p.enabled && p.id !== 'subagent')
        .reduce((sum, p) => {
          const maxCalls = Number(p.params.find((x) => x.key === 'max_calls')?.value ?? 0);
          return sum + (Number.isFinite(maxCalls) && maxCalls > 0 ? maxCalls : 0);
        }, 0),
    );
    /* 轮次上限：判定规则集中在 agent/rounds.ts（含"不设硬上限"这条）。
       子智能体的上限在 runs.ts 里就算好了（它要写进 run.maxRoundsHint），这里只用。 */
    const maxRounds = input.isSub
      ? resolveSubRounds({ hint: run.maxRoundsHint })
      : resolveMainRounds(settings.system.maxRounds, budgetRounds);

    /* 7) 落盘节流 */
    let lastPersist = 0;
    const persist = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastPersist < 1500) return;
      lastPersist = now;
      if (input.isSub) return;
      asst.content = asst.content || '';
      asst.thinking = thinkingFull || undefined;
      asst.calls = calls;
      putSession(session!);
    };

    let thinkingFull = '';
    let streamedContent = '';
    let statsTotal = { in: 0, out: 0, ms: 0 };
    /** 这一段运行最后的 turn/step（落盘到助手消息，刷新后统计行仍显示） */
    let lastTurn = 0;
    let lastStep = 0;

    /* 超长工具结果的落盘配置（系统参数，服务端不设硬上限；见 agent/spill.ts）。
       回灌给模型的文本超阈值 → 落盘 + 只给头尾预览与路径；journal 仍存全文（可审计）。 */
    const spillCfg = spillConfigFrom(settings.system);

    /* 插话/打断：取队列的同时，把它**落成会话里的用户消息**（刷新后仍在）。
       界面上的排队条靠 `steer` 事件的 `taken` 收掉（takeQueued 里已经广播过）。 */
    const takeQueued = (mode: SteerMode): string[] => {
      const items = deps.takeQueued(run.sessionId, mode);
      const out = items.map((i) => i.text);
      for (const item of items) {
        const text = item.text;
        /* 插话**不画气泡**：它在界面上的唯一呈现就是循环注入的那句浅文字提示
           （见 Message.jsx 的 notices）。所以这里记下模式，提示由 onNotice 落盘。 */
        const m = newMessage('user', text, { steer: true, steerMode: mode === 'queue' ? 'steer' : mode });
        // 插话插在"当前助手占位"之前 —— 走日志的 insert 事件（重放时也落在同一位置）
        insertMessage(session!, asst.id, m);
        if (!input.isSub) {
          putSession(session!);
          emit({ type: 'msg', runId: run.id, sessionId: session!.id, msg: m });
        }
      }
      return out;
    };

    /* 8) 跑循环 */
    emitUsage(history, 0); // 开跑前先报一次占用：界面顶栏的上下文环立刻有数
    const result = await runLoop({
      cfg: providerCfg,
      params: settings.params,
      sys: settings.system,
      system,
      history,
      tools: executor.toolDefs().filter((t) => !(input.isSub && t.name === 'spawn_agent')),
      maxRounds,
      isExclusive: (name) => executor.isExclusive(name),
      signal: run.controller.signal,
      log,
      runTool: async (call, seq, at, toolSignal) => {
        const record: CallRecord = {
          seq,
          contentAt: at,
          name: call.name,
          label: labelOf(call.name, deps.plugins, deps.resources),
          plugin: deps.plugins.pluginOfTool(call.name)?.id ?? 'unknown',
          argsDigest: digestArgs(call.args),
          state: 'running',
        };
        calls.push(record);
        emit({ type: 'call', runId: run.id, sessionId: session!.id, msgId: asst.id, call: { ...record } });

        /* 工具自己只认一个 signal：整段运行的中断（停止）与"这一个工具的掐断"
           （用户点打断）合并成一个 —— 任一触发，工具都得停。
           AbortSignal.any 在 Node 18+ 可用（本工程 engines 要求 >=22.6）。 */
        const exec = await executor.run(call, seq, toolSignal);
        record.state = exec.result.ok ? 'ok' : 'fail';
        if (!exec.result.ok && exec.result.errorCode) record.errorCode = exec.result.errorCode;
        record.ms = exec.ms;
        record.digest = exec.result.note ?? '';
        record.chars = exec.result.text.length;
        if (exec.result.lines) record.lines = exec.result.lines;
        if (exec.result.files?.length) record.files = exec.result.files;
        if (exec.result.media?.length) record.media = exec.result.media;
        if (call.name === 'spawn_agent') {
          const m = /转录运行 ID：(\w+)/.exec(exec.result.text);
          if (m) record.subRunId = m[1];
        }
        journal.saveCall({
          seq,
          name: call.name,
          pluginId: exec.pluginId,
          args: call.args,
          ok: exec.result.ok,
          ...(exec.result.errorCode ? { errorCode: exec.result.errorCode } : {}),
          text: exec.result.text,
          ms: exec.ms,
        });
        /* 超长结果落盘：journal 存的是**全文**（审计用），这里只把回灌给模型的那份换成
           头尾预览 + 路径。落盘失败时 maybeSpill 返回原文，行为不变。 */
        const spilled = maybeSpill(spillCfg, { runId: run.id, seq, name: call.name }, exec.result.text);
        if (spilled.path) record.spill = { path: spilled.path, chars: spilled.chars ?? exec.result.text.length };
        emit({ type: 'call_done', runId: run.id, sessionId: session!.id, msgId: asst.id, call: { ...record } });
        persist();
        if (exec.result.refreshPrompt) system = systemOf();
        return {
          ok: exec.result.ok,
          text: spilled.text,
          ...(exec.result.errorCode ? { errorCode: exec.result.errorCode } : {}),
          ...(exec.result.images?.length ? { images: exec.result.images } : {}),
        };
      },
      events: {
        onThinkingDelta: (text) => {
          thinkingFull += text;
          emit({ type: 'thinking', runId: run.id, sessionId: session!.id, msgId: asst.id, text });
        },
        onThinkingSig: () => {
          /* 签名累积在 loop 内部，落盘在结束时统一做 */
        },
        onContentDelta: (text) => {
          streamedContent += text;
          emit({ type: 'content', runId: run.id, sessionId: session!.id, msgId: asst.id, text });
        },
        onRound: (info) => {
          statsTotal.in += info.usage.input;
          statsTotal.out += info.usage.output;
          statsTotal.ms += info.ms;
          lastTurn = info.turn;
          lastStep = info.step;
          emit({
            type: 'round',
            runId: run.id,
            sessionId: session!.id,
            msgId: asst.id,
            round: info.round,
            turn: info.turn,
            step: info.step,
            stats: { in: info.usage.input, out: info.usage.output, ms: info.ms },
          });
          // 每轮收尾都重报一次占用：界面上下文环随对话推进实时更新
          emitUsage(history, info.round);
        },
        onNotice: (notice: LoopNotice, rendered: string) => {
          notices.push(rendered); // 落盘（插话的唯一呈现，刷新后不能丢）
          emit({ type: 'notice', runId: run.id, sessionId: session!.id, msgId: asst.id, text: rendered });
        },
        takeSteering: () => takeQueued('steer'),
        takeUrgent: () => takeQueued('urgent'),
        onCallStart: (ac) => {
          run.currentCall = ac;
        },
        onToolStart: (ac) => {
          run.currentTool = ac;
        },
        render: (id, vars) => deps.prompts.text(id, vars),
      },
    });

    /* 9) 收尾：定稿消息 → 落盘 → 广播 */
    /* 正文 = **所有轮**拼起来的叙述（不只是最后一轮）：这样"模型先说一句话、再发图、再说一句"
       的顺序才留得住 —— 卡片按 contentAt 插在各轮正文之间（主流 harness 的转录也是这样分段的）。
       run.finalText 仍只取最后一轮（子智能体把结论带回去时不该带上中间的碎碎念）。 */
    asst.content = streamedContent || result.finalText;
    asst.thinking = thinkingFull || undefined;
    asst.calls = calls;
    asst.notices = notices.length ? notices : undefined;
    asst.stats = { in: statsTotal.in, out: statsTotal.out, ms: statsTotal.ms };
    if (lastTurn) asst.turn = lastTurn;
    if (lastStep) asst.step = lastStep;
    if (!result.ok && result.error) asst.error = result.error;
    journal.saveThinking(asst.id, thinkingFull, '');
    run.finalText = result.finalText || streamedContent;
    /* 定稿：占位（先前进日志的那个快照）此刻补全 —— 用 replace 事件把定稿写回日志，
       于是"从日志重放"得到的就是定稿后的这条助手消息（真源自洽）。 */
    replaceMessage(session, asst);
    if (!input.isSub) putSession(session);

    run.status = result.aborted ? 'stopped' : result.ok ? 'ok' : 'error';
    if (result.error) run.error = result.error;
    if (!input.isSub) emit({ type: 'msg', runId: run.id, sessionId: session.id, msg: asst });
    emit({
      type: 'run_end',
      runId: run.id,
      sessionId: session.id,
      status: run.status,
      error: run.error,
      ms: Date.now() - run.startedAt,
    });
    log.info(`运行结束 ${run.id}`, { status: run.status, rounds: result.rounds, ms: Date.now() - run.startedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`运行失败 ${run.id}`, { message });
    run.status = 'error';
    run.error = message;
    emit({ type: 'run_end', runId: run.id, sessionId: run.sessionId, status: 'error', error: message });
  } finally {
    run.endedAt = Date.now();
    journal.close();
    if (session && !run.parentRunId) {
      /* 会话可能被别的运行改过（多会话并发），按 id 重读-合并-写回，避免互相覆盖 */
      try {
        const fresh = readSessions();
        const idx = fresh.sessions.findIndex((s) => s.id === session!.id);
        if (idx >= 0) fresh.sessions[idx] = session;
        writeSessions(fresh);
      } catch (err) {
        log.warn('收尾落盘失败', { err: String(err) });
      }
    }
  }
}

/* ────────────────────────── 小工具 ────────────────────────── */

export function toRequestMessages(msgs: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.content?.trim()) out.push({ role: 'assistant', content: m.content });
  }
  return out;
}

function labelOf(name: string, plugins: RunnerDeps['plugins'], resources: RunnerDeps['resources']): string {
  const plugin = plugins.pluginOfTool(name);
  const res = plugin ? resources.get(plugin.id) : null;
  if (res) return `${res.name} · ${name}`;
  return plugin ? `${plugin.name} · ${name}` : name;
}

function digestArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return '';
  }
}


