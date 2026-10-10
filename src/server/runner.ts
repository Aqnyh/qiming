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
import { createToolExecutor } from '../agent/tools.ts';
import { assembleSystem } from '../agent/prompt.ts';
import { collectText, compactRange, estimateMessages, needsCompaction, summarize, usageOf } from '../agent/context.ts';
import { encoderFor } from '../agent/count.ts';
import { getSession, newMessage, newSession, putSession, touchTitle, writeSessions, readSessions } from '../store/sessions.ts';
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
import type { Run } from './run-types.ts';
import { MAX_KEEP_EVENTS } from './run-types.ts';

const log = logger('run');

export type RunnerDeps = {
  /** 取走排队队列（会话级，注册表持有）：urgent 优先；返回的条目会被落成会话消息 */
  takeQueued: (sessionId: string, mode: 'steer' | 'urgent') => Array<{ id: string; text: string; ts: number; mode: 'steer' | 'urgent' }>;
  queueOf: (sessionId: string) => Array<{ id: string; text: string; ts: number; mode: 'steer' | 'urgent' }>;
  plugins: ReturnType<typeof import('../modules/plugins/registry.ts').createPluginRegistry>;
  prompts: ReturnType<typeof import('../modules/prompts/registry.ts').createPromptRegistry>;
  resources: ReturnType<typeof import('../modules/resources/index.ts').createResourceRegistry>;
  sudoPassword: () => string;
  /** 由注册表提供的子运行入口 */
  spawnSubRun: (parent: Run, task: string, opts: { tools?: string[]; readOnly?: boolean; maxRounds?: number }) => Promise<{ ok: boolean; text: string; runId: string }>;
};

export type StartInput = {
  sessionId: string;
  text: string;
  providerId?: string | null;
  /** 界面上"停止"用不到这里；这是内部用（子智能体复用同一函数） */
  isSub?: boolean;
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
    // 子智能体的会话是**临时**的：只活在内存里，绝不写进用户的会话文件
    session = input.isSub
      ? newSession({ projectId: run.projectId, providerId: input.providerId ?? null })
      : (getSession(run.sessionId) ?? putSession(newSession({ projectId: run.projectId })));
    run.sessionId = session.id;
    const settings = readSettings();
    const provider =
      providerOf(settings, input.providerId ?? session.providerId) ?? providerOf(settings, settings.activeId);
    if (!provider) throw new Error('还没有配置模型服务商：打开「设置 → 模型」加一个（Base URL + 模型名 + Key）。');

    const project = findProject(session.projectId ?? run.projectId);
    const cwd = cwdOf(project, osHome());

    /* 1) 用户消息 */
    const userMsg = newMessage('user', input.text, { ...(input.isSub ? { steer: false } : {}) });
    session.msgs.push(userMsg);
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
    session.msgs.push(asst);

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

    /* 4) 请求视图（跨轮只带用户话与助手正文；工具原文不跨轮） */
    // 跨轮只带用户话与助手正文（工具原文不跨轮）；
    // slice(0,-2) 去掉本轮的"用户消息 + 助手占位"，再把这轮的提问作为最后一条补回来
    const history: ChatMessage[] = input.isSub ? [] : toRequestMessages(session.msgs.slice(0, -2));
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

    /* 5) 压缩（超阈值才做，失败不影响本次运行） */
    if (
      !input.isSub &&
      ctxLimit > 0 &&
      needsCompaction({
        messages: history,
        compact: session.compact ?? null,
        overheadTokens: overhead(),
        ctxLimit,
        compactHeader: '',
        model: provider.model,
      })
    ) {
      const range = compactRange(history, 6);
      if (range) {
        try {
          const complete = async (cfg: ProviderConfig, msgs: ChatMessage[], opts: { signal?: AbortSignal }) =>
            collectText(providerChat(cfg, msgs, { ...opts, params: { ...settings.params, thinkingBudget: 0 } }));
          const text = await summarize(history.slice(0, range.upTo), deps.prompts.text('compact.prompt'), complete, providerCfg, run.controller.signal);
          if (text) {
            session.compact = { upTo: range.upTo, count: range.upTo, text, ts: Date.now() };
            putSession(session);
            log.info('已压缩上下文', { upTo: range.upTo, tokens: estimateMessages(history, provider.model) });
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
    const maxRounds = input.isSub ? Math.max(2, Number(run.maxRoundsHint ?? 12)) : Math.min(budgetRounds + 2, 200);

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

    /* 插话/立即执行：取队列的同时，把它**落成会话里的用户消息**（刷新后仍在），
       并广播 steer 事件让界面把本地气泡换成"已生效"。 */
    const takeQueued = (mode: 'steer' | 'urgent'): string[] => {
      const items = deps.takeQueued(run.sessionId, mode);
      const out = items.map((i) => i.text);
      for (const item of items) {
        const text = item.text;
        /* 插话**不画气泡**：它在界面上的唯一呈现就是循环注入的那句浅文字提示
           （见 Message.jsx 的 notices）。所以这里记下模式，提示由 onNotice 落盘。 */
        const m = newMessage('user', text, { steer: true, steerMode: mode });
        const at = session!.msgs.findIndex((x) => x.id === asst.id);
        if (at >= 0) session!.msgs.splice(at, 0, m);
        else session!.msgs.push(m);
        if (!input.isSub) {
          putSession(session!);
          emit({ type: 'msg', runId: run.id, sessionId: session!.id, msg: m });
        }
        emit({ type: 'steer', runId: run.id, sessionId: session!.id, msgId: asst.id, id: item.id, text, mode, state: 'taken' });
      }
      return out;
    };

    /* 8) 跑循环 */
    emitUsage(history, 0); // 开跑前先报一次占用：界面顶栏的上下文环立刻有数
    const result = await runLoop({
      cfg: providerCfg,
      params: settings.params,
      system,
      history,
      tools: executor.toolDefs().filter((t) => !(input.isSub && t.name === 'spawn_agent')),
      maxRounds,
      isExclusive: (name) => executor.isExclusive(name),
      signal: run.controller.signal,
      log,
      runTool: async (call, seq, at) => {
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

        const exec = await executor.run(call, seq);
        record.state = exec.result.ok ? 'ok' : 'fail';
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
          text: exec.result.text,
          ms: exec.ms,
        });
        emit({ type: 'call_done', runId: run.id, sessionId: session!.id, msgId: asst.id, call: { ...record } });
        persist();
        if (exec.result.refreshPrompt) system = systemOf();
        return { ok: exec.result.ok, text: exec.result.text, ...(exec.result.images?.length ? { images: exec.result.images } : {}) };
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
          emit({
            type: 'round',
            runId: run.id,
            sessionId: session!.id,
            msgId: asst.id,
            round: info.round,
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
    if (!result.ok && result.error) asst.error = result.error;
    journal.saveThinking(asst.id, thinkingFull, '');
    run.finalText = result.finalText || streamedContent;
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


