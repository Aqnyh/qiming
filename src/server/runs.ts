/**
 * src/server/runs.ts —— 运行注册表：多会话并发的那一层。
 *
 * 规则（需求 7：多个会话同时开多个循环）：
 *  · 一条会话同一时刻只有一段运行；再来消息 = **插话**（下一轮次注入，不打断当前调用）；
 *  · 不同会话各自一段运行，互不阻塞；全局有并发上限（默认 8，env 可调）；
 *  · 运行对象带事件订阅（界面的 SSE 从这里走），刷新页面先回放再续播；
 *  · 停止 = abort 该运行的 AbortController：模型流立刻断，正在跑的工具整组杀掉。
 */
import { randomBytes } from 'node:crypto';
import { logger } from '../util/log.ts';
import { executeRun, type RunnerDeps } from './runner.ts';
import type { QueueItem, Run, RunStatus, SteerMode } from './run-types.ts';
import { MAX_KEEP_EVENTS } from './run-types.ts';
import type { RunEvent } from './journal.ts';
import { deleteSession, getSession, putSession } from '../store/sessions.ts';
import { newSession } from '../store/sessions.ts';
import type { Session } from '../store/sessions.ts';
import { readSettings } from '../store/settings.ts';
import { resolveSubRounds } from '../agent/rounds.ts';

const log = logger('runs');

export type StartResult = {
  ok: boolean;
  runId?: string;
  sessionId: string;
  steered?: boolean;
  /** 排队的条目（steered 时返回，界面拿它直接显示在输入框上方） */
  item?: QueueItem;
  /** 插话的生效方式（steer = 安全点注入，urgent = 立刻打断，queue = 这一段之后） */
  mode?: SteerMode;
  error?: string;
};

// takeQueued / queueOf / subagentCtrl 由注册表自己持有并注入给 run-loop，所以构造注册表时不用传
export type RunDeps = Omit<RunnerDeps, 'spawnSubRun' | 'takeQueued' | 'queueOf' | 'subagentCtrl'>;

export type RunSummary = {
  id: string;
  sessionId: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  task?: string;
  parentRunId?: string;
};

export function createRunRegistry(deps: RunDeps) {
  const runs = new Map<string, Run>();
  const bySession = new Map<string, string>();
  /** 会话级的排队队列：先排队，用户可逐条删除/立即执行；运行结束还有剩的就接着开下一段 */
  const queues = new Map<string, QueueItem[]>();
  /**
   * 子智能体登记表（控制面）：id → 它的内存会话 + 元信息。
   * 有了它，子智能体就不只是"把结论带回来就消失"：父体可以 `subagent_send` 续谈、
   * `subagent_stop` 中断、`subagent_list` 列举（对照 dsh 的 subagent 家族）。
   * 只活在内存里（进程重启即散），转录仍在各自的 runs/<runId>/。
   */
  const subagents = new Map<
    string,
    {
      id: string;
      task: string;
      session: Session;
      createdAt: number;
      runIds: string[];
      current?: Run;
      finalText?: string;
      status: RunStatus;
      /** 父运行的归属信息（续谈时用它把子运行挂回同一会话/项目） */
      parentSessionId: string;
      parentProjectId: string | null;
      parentRunId: string;
    }
  >();
  const hub = new Set<(ev: RunEvent) => void>();
  /**
   * 并发上限（同时跑几个会话）：**系统参数优先**（设置 → 系统 → maxRuns），
   * `0` = 不限制（`Infinity`）。每次调用都读设置（热加载，改完下一个 start 就生效）。
   * 缺省值 8 与旧行为一致（见 DEFAULT_SYSTEM）。
   */
  const maxRunsOf = (): number => {
    const n = Math.trunc(Number(readSettings().system.maxRuns ?? 8));
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  };

  function newRun(sessionId: string, projectId: string | null, extra?: Partial<Run>): Run {
    const run: Run = {
      id: randomBytes(6).toString('hex'),
      sessionId,
      projectId,
      status: 'running',
      startedAt: Date.now(),
      controller: new AbortController(),
      currentCall: null,
      currentTool: null,
      events: [],
      listeners: new Set(),
      emitted: 0,
      ...extra,
    };
    runs.set(run.id, run);
    return run;
  }

  function broadcast(ev: RunEvent): void {
    for (const fn of hub) {
      try {
        fn(ev);
      } catch {
        /* 单个连接出错不影响别人 */
      }
    }
  }

  /** 把运行的内部事件接到全局 hub（每段运行一个转发器，运行结束摘掉） */
  function pipe(run: Run): void {
    run.listeners.add(broadcast);
  }

  function activeTopLevel(): Run[] {
    return [...runs.values()].filter((r) => r.status === 'running' && !r.parentRunId);
  }

  function start(input: {
    sessionId?: string;
    projectId?: string | null;
    text: string;
    providerId?: string | null;
    /** steer（默认，安全点注入）= 不打断；urgent = 立刻打断转向；queue = 排到这一段之后 */
    mode?: SteerMode;
  }): StartResult {
    const text = String(input.text ?? '').trim();
    if (!text) return { ok: false, sessionId: '', error: '消息不能为空' };

    let sessionId = input.sessionId ?? '';
    if (!sessionId) {
      const session = putSession(newSession({ projectId: input.projectId ?? null, providerId: input.providerId ?? null }));
      sessionId = session.id;
    } else if (!getSession(sessionId)) {
      const session = putSession(newSession({ projectId: input.projectId ?? null, providerId: input.providerId ?? null }));
      session.id = sessionId; // 客户端指定的 id 优先
      putSession(session);
    }

    const existingId = bySession.get(sessionId);
    const existing = existingId ? runs.get(existingId) : null;
    if (existing && existing.status === 'running') {
      /* 兜底与 api.ts 保持一致：没给合法 mode 就用系统参数里的默认（出厂 queue） */
      const fallback = readSettings().system.queueDefault ?? 'queue';
      const mode: SteerMode = input.mode === 'urgent' || input.mode === 'queue' || input.mode === 'steer' ? input.mode : fallback;
      const item = enqueue(sessionId, text, mode);
      // 广播"收下了"：队列不只发起者要看（另一台设备/刷新后的标签页都要能看到）
      broadcast({ type: 'steer', runId: existing.id, sessionId, id: item.id, text, mode, state: 'queued' });
      if (mode === 'urgent') {
        /* 打断：掐掉**当前正在跑的东西**（模型流，或正在跑的那个工具 —— 工具的掐断把手
           由循环的 onToolStart 交上来，见 agent/loop.ts 的 executeTools）。 */
        existing.currentCall?.abort();
        existing.currentTool?.abort();
        log.info(`打断：掐掉当前调用/工具 ${existing.id}`, { sessionId, id: item.id });
      } else if (mode === 'queue') {
        log.info(`已排队（这一段跑完再执行）${existing.id}`, { sessionId, id: item.id });
      } else {
        log.info(`已插话（下一个安全点注入）${existing.id}`, { sessionId, id: item.id });
      }
      return { ok: true, runId: existing.id, sessionId, steered: true, mode, item };
    }

    const maxRuns = maxRunsOf();
    if (activeTopLevel().length >= maxRuns) {
      return { ok: false, sessionId, error: `同时运行的会话已达上限（${maxRuns}）。先停一段，或到「设置 → 系统」调大「同时运行会话数」上限（0 = 不限）。` };
    }

    const session = getSession(sessionId)!;
    const run = newRun(sessionId, session.projectId ?? input.projectId ?? null);
    bySession.set(sessionId, run.id);
    pipe(run);
    /**
     * 先回响应、再开跑（延到下一个 tick）。
     * 为什么：`executeRun` 的首次 emit（用户那条消息）在第一个 await 之前是**同步**写进 SSE 的 ——
     * 不延一下，事件就会抢在 HTTP 响应前面到达浏览器，客户端在两条通道上抢跑
     * （本地乐观条与服务端那条都显示出来 = "发出去两条、刷新变一条"）。
     * 客户端也已经能容忍两种顺序（见 ui/state/session.js 的 withOptimistic），这里是双保险。
     */
    setTimeout(() => {
      void executeRun(run, { sessionId, text, providerId: input.providerId }, { ...deps, spawnSubRun, takeQueued, queueOf, subagentCtrl })
        .catch((err) => log.error('运行异常退出', { err: String(err) }))
        .finally(() => {
          if (bySession.get(sessionId) === run.id) bySession.delete(sessionId);
          // 这一段跑完还有排队的消息 → 接着开下一段（标准做法：排队在"这一轮结束"时自动兑现）
          flushQueue(sessionId);
        });
    }, 0);
    return { ok: true, runId: run.id, sessionId };
  }

  /** 子智能体：独立运行 id、独立预算、不写会话（它的转录只在 runs/<runId>/） */
  async function spawnSubRun(
    parent: Run,
    task: string,
    opts: { tools?: string[]; readOnly?: boolean; maxRounds?: number },
  ): Promise<{ ok: boolean; text: string; runId: string; id: string }> {
    const id = randomBytes(4).toString('hex');
    const session = newSession({ projectId: parent.projectId, providerId: null });
    subagents.set(id, {
      id,
      task: task.slice(0, 400),
      session,
      createdAt: Date.now(),
      runIds: [],
      status: 'running',
      parentSessionId: parent.sessionId,
      parentProjectId: parent.projectId,
      parentRunId: parent.id,
    });
    return runSubTurn(id, parent, buildSubTask(task, opts), opts);
  }

  /**
   * 跑子智能体的**一轮**（首次 spawn 与之后续谈都走它）。
   * 复用它自己的内存会话 → 续谈时历史还在，"接着上次的结论继续问"才成立。
   */
  async function runSubTurn(
    id: string,
    parent: Run,
    text: string,
    opts: { tools?: string[]; readOnly?: boolean; maxRounds?: number },
  ): Promise<{ ok: boolean; text: string; runId: string; id: string }> {
    const info = subagents.get(id);
    if (!info) return { ok: false, text: `子智能体 ${id} 不存在（可能已重启进程）。`, runId: '', id };
    const maxRounds = resolveSubRounds({
      hint: opts.maxRounds,
      pluginParam: deps.plugins.paramsOf('subagent')['max_rounds'],
    });
    const run = newRun(parent.sessionId, parent.projectId, {
      parentRunId: parent.id,
      task: info.task,
      maxRoundsHint: maxRounds,
    });
    info.runIds.push(run.id);
    info.current = run;
    info.status = 'running';
    pipe(run);
    try {
      await executeRun(
        run,
        { sessionId: parent.sessionId, text, isSub: true, subSession: info.session },
        { ...deps, spawnSubRun, takeQueued, queueOf, subagentCtrl },
      );
      info.status = run.status;
      info.finalText = run.finalText ?? '';
      info.current = undefined;
      return { ok: run.status === 'ok', text: run.finalText ?? '（子智能体没有产出结论）', runId: run.id, id };
    } catch (err) {
      info.status = 'error';
      info.current = undefined;
      return { ok: false, text: `子智能体运行失败：${err instanceof Error ? err.message : String(err)}`, runId: run.id, id };
    } finally {
      // 子运行的事件保留一段时间供界面展开；转录在磁盘上，不占内存
      setTimeout(() => run.events.length && run.listeners.clear(), 1);
    }
  }

  /**
   * 子智能体控制面（注入给工具层）：
   *  · list  —— 有哪些子体、各自什么状态（可列举、可审计）
   *  · send  —— 给某个子体再发一句话，它带着自己的历史接着做（可续）
   *  · stop  —— 掐掉它当前那一段（可中断）
   */
  const subagentCtrl = {
    list: () =>
      [...subagents.values()].map((s) => ({
        id: s.id,
        task: s.task,
        status: s.status,
        parentRunId: s.current?.parentRunId,
        createdAt: s.createdAt,
        runs: s.runIds.length,
        finalText: s.finalText,
      })),
    send: async (id: string, text: string) => {
      const info = subagents.get(id);
      if (!info) return { ok: false, text: `子智能体 ${id} 不存在。`, runId: '', id };
      if (info.current?.status === 'running') return { ok: false, text: `子智能体 ${id} 正在跑，先等它这一段结束或用 subagent_stop 中断。`, runId: info.current.id, id };
      /* 续谈只需用到父运行的"归属信息"（会话/项目），用登记表里记下的那份重建即可
         —— 父运行可能早已结束，不必真的持有它。 */
      const parent: Run = {
        id: info.parentRunId,
        sessionId: info.parentSessionId,
        projectId: info.parentProjectId,
        status: 'running',
        startedAt: Date.now(),
        controller: new AbortController(),
        currentCall: null,
        currentTool: null,
        events: [],
        listeners: new Set(),
        emitted: 0,
      };
      return runSubTurn(id, parent, text, {});
    },
    stop: (id: string) => {
      const info = subagents.get(id);
      if (!info?.current || info.current.status !== 'running') return false;
      info.current.controller.abort();
      info.current.status = 'stopped';
      info.status = 'stopped';
      return true;
    },
  };

  function buildSubTask(task: string, opts: { tools?: string[]; readOnly?: boolean }): string {
    const lines = [deps.prompts.text('loop.subagent.intro')];
    if (opts.readOnly) lines.push('本次是只读调研：只允许读取与检索，不要修改任何文件或运行有副作用的命令。');
    if (opts.tools?.length) lines.push(`只使用这些工具：${opts.tools.join(', ')}`);
    lines.push('', '任务：', task, '', deps.prompts.text('loop.subagent.report'));
    return lines.filter((l) => l !== undefined).join('\n');
  }

  /* ────────────────────────── 排队队列 ────────────────────────── */

  function queueOf(sessionId: string): QueueItem[] {
    return queues.get(sessionId) ?? [];
  }

  function enqueue(sessionId: string, text: string, mode: SteerMode): QueueItem {
    const item: QueueItem = { id: randomBytes(4).toString('hex'), text, ts: Date.now(), mode };
    queues.set(sessionId, [...queueOf(sessionId), item]);
    return item;
  }

  function removeQueued(sessionId: string, id: string): boolean {
    const cur = queueOf(sessionId);
    const next = cur.filter((i) => i.id !== id);
    if (next.length === cur.length) return false;
    if (next.length) queues.set(sessionId, next);
    else queues.delete(sessionId);
    return true;
  }

  /**
   * 「立刻执行这一条」：把它标成 urgent 并**掐掉当前正在跑的东西**。
   *
   * 与 `mode:'queue'` 的分工：queue 是"排在这一段之后"，这里是"别等了，现在就转向"。
   * 两者在界面上的按钮也不同（排队条里的「立即执行」= 这里）。
   */
  function executeQueued(sessionId: string, id: string): boolean {
    const cur = queueOf(sessionId);
    const item = cur.find((i) => i.id === id);
    if (!item) return false;
    item.mode = 'urgent';
    const run = ofSession(sessionId);
    // 掐模型流 + 掐正在跑的那个工具：一次 5 分钟的命令不该拦着"立即执行"
    run?.currentCall?.abort();
    run?.currentTool?.abort();
    // 让所有观察者把这条的样式改成"已请求立即执行"
    broadcast({ type: 'steer', runId: run?.id ?? '', sessionId, id: item.id, text: item.text, mode: 'urgent', state: 'queued' });
    log.info('立即执行排队中的消息', { sessionId, id });
    return true;
  }

  /**
   * 循环在安全点取走队列（宿主注入给 run-loop）。
   *
   * `steer`（安全点注入）与 `urgent`（宿主掐断后取走）都会**移出队列并广播 taken**：
   * 排队条立刻消失。为什么不等落盘那条 `msg` 事件 —— 消息可能还没落（工具没跑完），
   * 排队条就会僵在那里显示"已生效"却不消失（实测就是这个观感）。
   *
   * `queue` 永远不会被这里取走：它要等 `flushQueue`（这一段运行之后）。
   */
  function takeQueued(sessionId: string, mode: SteerMode): QueueItem[] {
    const cur = queueOf(sessionId);
    const taken = cur.filter((i) => i.mode === mode);
    if (!taken.length) return [];
    const rest = cur.filter((i) => i.mode !== mode);
    if (rest.length) queues.set(sessionId, rest);
    else queues.delete(sessionId);
    for (const item of taken) {
      broadcast({ type: 'steer', runId: bySession.get(sessionId) ?? '', sessionId, id: item.id, text: item.text, mode, state: 'taken' });
    }
    return taken;
  }

  /**
   * 一段运行结束：把**排队（queue）**的条目接着兑现成新的一段。
   *
   * 只兑现 `mode === 'queue'` 的：steer/urgent 是"注入当前运行"的语义，
   * 它们要么已经被安全点取走，要么（用户刚点的、循环还没来得及取）说明这段已经结束了 ——
   * 此时把它们当新消息执行是合理的，但**顺序上要排在 queue 后面**吗？不需要：
   * 运行已经结束，队列里剩下的这些本来就是用户希望"接着做"的，按入队顺序来即可。
   * 这里的取舍是：**一次只兑现队首那一条**（保持一致：剩下的等下一段结束时再兑现）。
   */
  function flushQueue(sessionId: string): void {
    const rest = queueOf(sessionId);
    if (!rest.length) return;
    const next = rest[0]!;
    removeQueued(sessionId, next.id);
    broadcast({ type: 'steer', runId: bySession.get(sessionId) ?? '', sessionId, id: next.id, text: next.text, mode: next.mode, state: 'taken' });
    log.info('运行结束，接着兑现排队中的消息', { sessionId, id: next.id, mode: next.mode });
    start({ sessionId, text: next.text });
  }

  function stop(runId?: string, sessionId?: string): boolean {
    const run = runId ? runs.get(runId) : sessionId ? runs.get(bySession.get(sessionId) ?? '') : null;
    if (!run || run.status !== 'running') return false;
    run.controller.abort();
    run.status = 'stopped';
    return true;
  }

  function ofSession(sessionId: string): Run | null {
    const id = bySession.get(sessionId);
    return id ? (runs.get(id) ?? null) : null;
  }

  function summaries(): RunSummary[] {
    return [...runs.values()]
      .filter((r) => r.status === 'running')
      .map((r) => ({ id: r.id, sessionId: r.sessionId, status: r.status, startedAt: r.startedAt, task: r.task, parentRunId: r.parentRunId }));
  }

  function subscribe(fn: (ev: RunEvent) => void): () => void {
    hub.add(fn);
    return () => hub.delete(fn);
  }

  /** 新连接进来先回放当前在跑的运行事件（含已结束的最近一次，避免错过收尾） */
  function replayFor(sessionId?: string): RunEvent[] {
    const out: RunEvent[] = [];
    for (const run of runs.values()) {
      if (sessionId && run.sessionId !== sessionId) continue;
      if (run.status !== 'running') continue;
      out.push(...run.events.slice(-MAX_KEEP_EVENTS));
    }
    return out;
  }

  function removeSession(sessionId: string, archive = false): boolean {
    const run = ofSession(sessionId);
    if (run?.status === 'running') return false;
    if (archive) return Boolean(putSession({ ...getSession(sessionId)!, id: sessionId }));
    return deleteSession(sessionId);
  }

  return {
    start, stop, ofSession, summaries, subscribe, replayFor, removeSession, runs,
    queueOf, removeQueued, executeQueued, subagents: subagentCtrl,
  };
}

export type RunRegistry = ReturnType<typeof createRunRegistry>;
