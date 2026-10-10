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
import type { QueueItem, Run, RunStatus } from './run-types.ts';
import { MAX_KEEP_EVENTS } from './run-types.ts';
import type { RunEvent } from './journal.ts';
import { deleteSession, getSession, putSession } from '../store/sessions.ts';
import { newSession } from '../store/sessions.ts';

const log = logger('runs');

export type StartResult = {
  ok: boolean;
  runId?: string;
  sessionId: string;
  steered?: boolean;
  /** 排队的条目（steered 时返回，界面拿它直接显示在输入框上方） */
  item?: QueueItem;
  /** 插话的生效方式（steer = 下一轮，urgent = 已打断当前调用） */
  mode?: 'steer' | 'urgent';
  error?: string;
};

// takeQueued / queueOf 由注册表自己持有并注入给 run-loop，所以构造注册表时不用传
export type RunDeps = Omit<RunnerDeps, 'spawnSubRun' | 'takeQueued' | 'queueOf'>;

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
  const hub = new Set<(ev: RunEvent) => void>();
  const maxRuns = Math.max(1, Number(process.env.QIMING_MAX_RUNS ?? 8));

  function newRun(sessionId: string, projectId: string | null, extra?: Partial<Run>): Run {
    const run: Run = {
      id: randomBytes(6).toString('hex'),
      sessionId,
      projectId,
      status: 'running',
      startedAt: Date.now(),
      controller: new AbortController(),
      currentCall: null,
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
    /** steer（排队，默认）= 下一轮次边界交给模型；urgent = 立刻打断当前调用并插到最前 */
    mode?: 'steer' | 'urgent';
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
      const mode = input.mode === 'urgent' ? 'urgent' : 'steer';
      const item = enqueue(sessionId, text, mode);
      // 广播"排队了"：队列不只发起者要看（另一台设备/刷新后的标签页都要能看到）
      broadcast({ type: 'steer', runId: existing.id, sessionId, id: item.id, text, mode, state: 'queued' });
      if (mode === 'urgent') {
        // 立即执行：把当前这次模型调用掐掉（运行本身不停）——循环那边会带着新指令重开一轮
        existing.currentCall?.abort();
        log.info(`立即执行：打断当前调用 ${existing.id}`, { sessionId, id: item.id });
      } else {
        log.info(`已排队（下一轮生效）${existing.id}`, { sessionId, id: item.id });
      }
      return { ok: true, runId: existing.id, sessionId, steered: true, mode, item };
    }

    if (activeTopLevel().length >= maxRuns) {
      return { ok: false, sessionId, error: `同时运行的会话已达上限（${maxRuns}）。先停一段，或调大 QIMING_MAX_RUNS。` };
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
      void executeRun(run, { sessionId, text, providerId: input.providerId }, { ...deps, spawnSubRun, takeQueued, queueOf })
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
  ): Promise<{ ok: boolean; text: string; runId: string }> {
    const maxRounds = Math.max(2, Number(opts.maxRounds ?? 0) || Number(deps.plugins.paramsOf('subagent')['max_rounds'] ?? 12));
    const run = newRun(parent.sessionId, parent.projectId, {
      parentRunId: parent.id,
      task: task.slice(0, 400),
      maxRoundsHint: maxRounds,
    });
    pipe(run);
    try {
      await executeRun(
        run,
        { sessionId: parent.sessionId, text: buildSubTask(task, opts), isSub: true },
        { ...deps, spawnSubRun, takeQueued, queueOf },
      );
      return { ok: run.status === 'ok', text: run.finalText ?? '（子智能体没有产出结论）', runId: run.id };
    } catch (err) {
      return { ok: false, text: `子智能体运行失败：${err instanceof Error ? err.message : String(err)}`, runId: run.id };
    } finally {
      // 子运行的事件保留一段时间供界面展开；转录在磁盘上，不占内存
      setTimeout(() => run.events.length && run.listeners.clear(), 1);
    }
  }

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

  function enqueue(sessionId: string, text: string, mode: 'steer' | 'urgent'): QueueItem {
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

  /** 「立即执行」：把它标成 urgent（下一轮边界会优先取走）并**掐掉当前这次模型调用** */
  function executeQueued(sessionId: string, id: string): boolean {
    const cur = queueOf(sessionId);
    const item = cur.find((i) => i.id === id);
    if (!item) return false;
    item.mode = 'urgent';
    const run = ofSession(sessionId);
    run?.currentCall?.abort();
    // 让所有观察者把这条的样式改成"已请求立即执行"
    broadcast({ type: 'steer', runId: run?.id ?? '', sessionId, id: item.id, text: item.text, mode: 'urgent', state: 'queued' });
    log.info('立即执行排队中的消息', { sessionId, id });
    return true;
  }

  /** 循环在轮次边界取走队列（宿主注入给 run-loop）：urgent 优先 */
  function takeQueued(sessionId: string, mode: 'steer' | 'urgent'): QueueItem[] {
    const cur = queueOf(sessionId);
    const taken = cur.filter((i) => i.mode === mode);
    if (!taken.length) return [];
    const rest = cur.filter((i) => i.mode !== mode);
    if (rest.length) queues.set(sessionId, rest);
    else queues.delete(sessionId);
    return taken;
  }

  /** 一段运行结束：还有排队的就接着开下一段（否则队列会永远挂着不执行） */
  function flushQueue(sessionId: string): void {
    const rest = queueOf(sessionId);
    if (!rest.length) return;
    const next = rest[0]!;
    removeQueued(sessionId, next.id);
    log.info('运行结束，接着兑现排队中的消息', { sessionId, id: next.id });
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
    queueOf, removeQueued, executeQueued,
  };
}

export type RunRegistry = ReturnType<typeof createRunRegistry>;
