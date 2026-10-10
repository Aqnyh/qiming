/**
 * src/agent/loop.ts —— 循环内核（整个智能体的心脏）。
 *
 * 一次"运行"= 反复做这几步，直到模型给出没有工具调用的最终回答：
 *   组装请求（system + 历史）→ 流式调模型 → 累积正文/思考/工具调用
 *   → 执行工具（并行或串行）→ 结果回灌 → 再来一轮。
 *
 * 移植自旧项目 agent.js 的循环，但剥掉了传输/账号/权限三层，只剩：
 *  · 截断保护：参数不完整或 stop=length 时不执行，回话让模型拆小重来；
 *  · 空回答守卫：连续空回复会追问，最多 NUDGE 次；
 *  · 重复守卫：同一调用连续成功两次还来第三次 → 注入提示，不真跑；
 *  · 思考打转守卫：纯思考没有产出 → 注入提示；
 *  · 单次调用超时：到点中止本次流，回话继续（不是整个运行失败）；
 *  · 上游错误重试：可重试类按 retryCount 退避重试；
 *  · 插话（steering）：轮次之间把用户新说的话注入。
 */
import { chat as providerChat } from '../providers/index.ts';
import type { ChatMessage, ProviderConfig, StreamEvent, ToolCall, ToolDef } from '../providers/types.ts';
import type { ModelParams } from '../store/settings.ts';
import type { Logger } from '../util/log.ts';

const NUDGE_MAX = 2;
const THINK_RUNAWAY_CHARS = 6000;
/** 退避基数（第 n 次重试等 RETRY_BASE_MS * 2^(n-1)，带 ±20% 抖动，封顶 RETRY_MAX_MS） */
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60_000;
/** 自动续跑之间的等待（重试预算用完后，隔久一点再试，别把上游打得更惨） */
const AUTO_CONTINUE_DELAY_MS = 15_000;
/** 连续被"掐断"（上游没给收尾标记就结束）允许自动续跑几次 —— 上限是为了不跟坏上游死磕 */
const INTERRUPT_MAX = 2;
/** 连续"输出被截断"（参数/正文不完整）允许几次 —— 实测坏上游会一路问到轮次上限，白烧预算 */
const TRUNC_MAX = 3;

export type RoundInfo = {
  round: number;
  content: string;
  thinking: string;
  calls: ToolCall[];
  stop: string;
  usage: { input: number; output: number };
  ms: number;
  aborted: boolean;
};

export type LoopNotice = { id: string; vars?: Record<string, string> };

export type LoopEvents = {
  onThinkingDelta: (text: string) => void;
  onThinkingSig: (sig: string) => void;
  onContentDelta: (text: string) => void;
  onRound: (info: RoundInfo) => void;
  /** 循环自己产生的一句提示（会同时发给界面并回灌给模型） */
  onNotice: (notice: LoopNotice, rendered: string) => void;
  /** 取出待注入的用户插话（轮次边界调用） */
  takeSteering: () => string[];
  /** 取出"立即执行"的话（打断当前调用后立刻注入） */
  takeUrgent: () => string[];
  /** 每次模型调用开始：宿主拿到中断把手（用户点「立即执行」时掐掉这一次调用） */
  onCallStart?: (ac: AbortController) => void;
  /** 渲染循环文案 */
  render: (id: string, vars?: Record<string, string>) => string;
};

export type LoopInput = {
  cfg: ProviderConfig;
  params: ModelParams;
  system: string;
  /** 请求视图（本函数会往里追加本轮产生的消息） */
  history: ChatMessage[];
  tools: ToolDef[];
  maxRounds: number;
  /**
   * 执行一次工具调用。`at` = 这次调用出现在正文里的字符偏移（本轮正文写完时的累计长度）——
   * 宿主拿它记进调用记录，界面据此把媒体/文件卡插到正确的位置。
   */
  runTool: (
    call: ToolCall,
    seq: number,
    at: number,
  ) => Promise<{ ok: boolean; text: string; images?: Array<{ mime: string; data: string }> }>;
  /** 该工具是否独占外部资源（屏幕/浏览器/写文件/命令）—— 独占的串行跑，其余并行 */
  isExclusive: (name: string) => boolean;
  events: LoopEvents;
  signal: AbortSignal;
  log: Logger;
};

export type LoopResult = {
  ok: boolean;
  aborted: boolean;
  rounds: number;
  error?: string;
  /** 最后一次模型回答（正文） */
  finalText: string;
};

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const { cfg, params, events, log, signal } = input;
  const history = input.history;
  let seq = 0;
  let nudges = 0;
  const maxRetries = Math.max(0, Number(params.retryCount ?? 2));
  let retriesLeft = maxRetries;
  /** 自动续跑（默认关）：重试预算用完后还接着试几次，让"上游抽风"不需要人工再发一句 */
  const maxAutoContinues = params.autoContinue ? Math.max(0, Number(params.autoContinueMax ?? 2)) : 0;
  let autoContinuesLeft = maxAutoContinues;
  /** 停滞看门狗：这么久没有任何字节就中止本次调用（0 = 关） */
  const stallSec = Math.max(0, Number(params.stallSec ?? 90));
  let interruptStreak = 0;
  let truncStreak = 0;
  let finalText = '';
  /** 循环自己产生的一句收尾文案：作为正文增量发出去（这样它既实时可见，也留在落盘的消息里） */
  const emitAside = (text: string): void => {
    if (text) events.onContentDelta(text);
  };
  /** 累计正文（跨轮）：用来算每次调用的位置 —— 消息里的正文是所有轮拼起来的，卡片要插在对应轮之后 */
  let textSoFar = '';
  const repeatGuard = new Map<string, number>();

  const rounds = Math.max(1, input.maxRounds);
  for (let round = 1; round <= rounds; round++) {
    if (signal.aborted) return { ok: false, aborted: true, rounds: round - 1, finalText };

    // 1) 插话注入（用户在上一步运行中说的事）
    for (const text of events.takeSteering()) {
      const rendered = events.render('loop.steering', { text });
      history.push({ role: 'user', content: rendered });
      events.onNotice({ id: 'loop.steering', vars: { text } }, rendered);
    }

    const messages: ChatMessage[] = [{ role: 'system', content: input.system }, ...history];
    const started = Date.now();
    let content = '';
    let thinking = '';
    let thinkingSig = '';
    let calls: ToolCall[] = [];
    let stop: string | null = null; // null = 全程没见到任何收尾标记（见下面的 clean 判定）
    let clean: boolean = true;
    let usage = { input: 0, output: 0 };
    let streamError: string | null = null;
    let streamRetryable: boolean | undefined;
    let retryAfterMs = 0;
    let stalled = false;

    // 2) 调模型（带单次调用超时；超时只中止这一次流）
    const callAc = new AbortController();
    events.onCallStart?.(callAc);
    const onOuterAbort = () => callAc.abort();
    signal.addEventListener('abort', onOuterAbort, { once: true });
    const timeoutMs = Math.max(30, Number(params.callTimeoutSec ?? 600)) * 1000;
    const timer = setTimeout(() => callAc.abort(), timeoutMs);

    /* 停滞看门狗（chunk watchdog）：**任何事件都算"还活着"** —— 包括工具参数的分片、
       思考增量、usage。所以"模型在慢慢拼一个很长的工具调用"不会被误杀，
       只有真正一个字节都没有才判停滞。生产实践里这是防"连上了但永远不出字"的标准做法。 */
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
      if (!stallSec) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        callAc.abort();
      }, stallSec * 1000);
    };

    try {
      armStall();
      for await (const ev of providerChat(cfg, messages, {
        tools: input.tools,
        params,
        signal: callAc.signal,
        sessionId: cfg.sessionId,
      })) {
        armStall();
        handle(ev);
      }
    } catch (err) {
      streamError = err instanceof Error ? err.message : String(err);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      clearTimeout(timer);
      signal.removeEventListener('abort', onOuterAbort);
    }

    const aborted = signal.aborted;
    const timedOut = !aborted && !stalled && callAc.signal.aborted;
    /** 上游没给收尾标记就结束了（既无 finish_reason 也无 [DONE]）—— 半截正文不能当最终回答 */
    const cut = !aborted && !stalled && !streamError && (!clean || stop === null);
    const ms = Date.now() - started;

    function handle(ev: StreamEvent): void {
      switch (ev.kind) {
        case 'thinking':
          thinking += ev.text;
          events.onThinkingDelta(ev.text);
          break;
        case 'thinking_sig':
          thinkingSig += ev.sig;
          events.onThinkingSig(ev.sig);
          break;
        case 'content':
          content += ev.text;
          events.onContentDelta(ev.text);
          break;
        case 'tool_calls':
          calls = calls.concat(ev.calls);
          break;
        case 'usage':
          usage = { input: ev.input, output: ev.output };
          break;
        case 'stop':
          stop = ev.reason || stop || 'stop';
          if (ev.clean === false) clean = false; // 上游没给收尾标记就结束了
          break;
        case 'error':
          streamError = ev.message;
          streamRetryable = ev.retryable;
          retryAfterMs = ev.retryAfterMs ?? 0;
          break;
      }
    }

    events.onRound({ round, content, thinking, calls, stop: stop ?? 'cut', usage, ms, aborted });

    if (aborted) return { ok: false, aborted: true, rounds: round, finalText: finalText || content };

    /* ★ 立即执行（urgent）优先于一切后续处理：
       用户点了"立即执行"，服务端掐掉了上面这次调用 —— 不执行（可能不完整的）工具调用、
       不按超时/报错处理，直接把已经生成的内容留档，注入新指令，马上开下一轮。
       这是 Codex instant_interrupt / Claude Code 里"Esc + 新指令"的等价物。 */
    const urgent = events.takeUrgent();
    if (urgent.length) {
      if (content.trim() || thinking.trim()) {
        history.push({
          role: 'assistant',
          content: content || '',
          ...(thinking ? { thinking } : {}),
          ...(thinkingSig ? { thinkingSig } : {}),
        });
      }
      for (const text of urgent) {
        const rendered = events.render('loop.steering_urgent', { text });
        history.push({ role: 'user', content: rendered });
        events.onNotice({ id: 'loop.steering_urgent', vars: { text } }, rendered);
      }
      nudges = 0;
      continue;
    }

    /* ★ 掐断守卫：上游没给收尾标记就结束了（既无 finish_reason 也无 [DONE]）。
       这是"半句停住"的经典形态 —— 不能把半截正文当成最终回答（旧项目的教训）。
       做法与主流一致：**抢救已生成的内容**（留成一条 assistant 消息）→ 注入"接着上次的进度继续"
       → 自动续跑。连续多次仍被掐断就停下并如实说明（不跟坏上游死磕）。 */
    if (cut) {
      interruptStreak += 1;
      if (interruptStreak > INTERRUPT_MAX) {
        const rendered = events.render('loop.interrupted_giveup', { n: String(INTERRUPT_MAX) });
        events.onNotice({ id: 'loop.interrupted_giveup' }, rendered);
        const aside = content.trim() ? `\n\n---\n${rendered}` : rendered;
        emitAside(aside);
        return { ok: true, aborted: false, rounds: round, finalText: aside };
      }
      const rendered = events.render('loop.interrupted');
      events.onNotice({ id: 'loop.interrupted' }, rendered);
      if (content.trim() || thinking.trim()) {
        history.push({
          role: 'assistant',
          content,
          ...(thinking ? { thinking } : {}),
          ...(thinkingSig ? { thinkingSig } : {}),
        });
      }
      history.push({ role: 'user', content: rendered });
      await sleep(backoffMs(interruptStreak, 0), signal);
      continue;
    }
    interruptStreak = 0; // 这一轮流是干净收尾的，续跑计数清零

    if (streamError) {
      /* 停滞看门狗掐的这次调用，适配器只看到 AbortError → 会报"请求已取消、不可重试"。
         那不是用户停的，是看门狗判的 —— 在这里先认领，改判为**可重试**并换成看得懂的话。 */
      const stalledNow = stalled;
      const message = stalledNow ? events.render('loop.stall', { sec: String(stallSec) }) : streamError;
      if (stalledNow) events.onNotice({ id: 'loop.stall', vars: { sec: String(stallSec) } }, message);
      // 上游自己标了可重试就听它的（429 也是可重试！）；它没标才退回按状态码猜
      const retryable = stalledNow ? true : (streamRetryable ?? !/HTTP 4\d\d/.test(streamError));
      const canRetry = retryable && round < rounds;
      const useRetryBudget = retriesLeft > 0;
      const useAutoContinue = !useRetryBudget && autoContinuesLeft > 0;
      if (canRetry && (useRetryBudget || useAutoContinue)) {
        let delay: number;
        let rendered: string;
        if (useRetryBudget) {
          retriesLeft -= 1;
          const n = maxRetries - retriesLeft;
          delay = backoffMs(n, retryAfterMs);
          rendered = events.render('loop.retry', { error: message.slice(0, 200), n: String(n) });
          events.onNotice({ id: 'loop.retry', vars: { n: String(n) } }, rendered);
        } else {
          // 自动续跑：重试预算用完了还接着试（默认关，见参数 autoContinue）
          autoContinuesLeft -= 1;
          const n = maxAutoContinues - autoContinuesLeft;
          delay = Math.max(retryAfterMs, AUTO_CONTINUE_DELAY_MS);
          rendered = events.render('loop.auto_continue', { error: message.slice(0, 200), n: String(n) });
          events.onNotice({ id: 'loop.auto_continue', vars: { n: String(n) } }, rendered);
        }
        history.push({ role: 'user', content: rendered });
        log.info('上游出错，自动重试', { n: delay, stalled: stalledNow, streamError: streamError.slice(0, 120) });
        await sleep(delay, signal);
        continue;
      }
      log.warn('模型调用失败', { streamError, retryable, stalled: stalledNow });
      return { ok: false, aborted: false, rounds: round, error: message, finalText: finalText || content };
    }

    /* 单次调用超时：只中止这一次流，不结束整个运行 —— 回话让模型换个更短的写法继续。
       （与"停滞"的区别：超时是整体太慢，停滞是一个字节都没有。） */
    if (timedOut) {
      const rendered = events.render('loop.call_timeout');
      events.onNotice({ id: 'loop.call_timeout' }, rendered);
      if (content.trim()) history.push({ role: 'assistant', content });
      history.push({ role: 'user', content: rendered });
      continue;
    }

    // 3) 无工具调用：要么是最终回答，要么需要追问
    if (!calls.length) {
      if (content.trim()) {
        finalText = content;
        return { ok: true, aborted: false, rounds: round, finalText };
      }
      // 纯思考没产出（思考打转）或彻底空回复
      nudges += 1;
      const runaway = thinking.length > THINK_RUNAWAY_CHARS;
      const id = runaway ? 'loop.think_loop' : 'loop.no_content';
      if (nudges > NUDGE_MAX) {
        const aside = thinking ? '（只有思考过程，没有给出结论）' : '（模型没有给出内容）';
        emitAside(aside);
        return { ok: true, aborted: false, rounds: round, finalText: aside };
      }
      const rendered = events.render(id);
      events.onNotice({ id }, rendered);
      history.push({ role: 'assistant', content: thinking ? `（思考）${thinking.slice(0, 500)}` : '' });
      history.push({ role: 'user', content: rendered });
      continue;
    }

    // 4) 截断保护：参数不完整或明确被长度截断 —— 不执行，回话让模型拆小
    const truncated = stop === 'length' || calls.some((c) => c.raw !== undefined);
    if (truncated) {
      truncStreak += 1;
      // 连续截断：坏上游会一路问到轮次上限（实测 86 次调用、白烧几万 token），够了就停
      if (truncStreak >= TRUNC_MAX) {
        const rendered = events.render('loop.truncated_giveup', { n: String(TRUNC_MAX) });
        events.onNotice({ id: 'loop.truncated_giveup' }, rendered);
        emitAside(rendered);
        return { ok: true, aborted: false, rounds: round, finalText: rendered };
      }
      const rendered = events.render('loop.truncated');
      events.onNotice({ id: 'loop.truncated' }, rendered);
      history.push({ role: 'assistant', content, ...(thinking ? { thinking, thinkingSig } : {}), toolCalls: calls });
      history.push({ role: 'user', content: rendered });
      continue;
    }
    truncStreak = 0; // 没截断就清零

    // 5) 执行工具：助手消息先进历史（保持 tool_calls 与 tool 结果配对）
    history.push({
      role: 'assistant',
      content,
      toolCalls: calls,
      ...(thinking ? { thinking } : {}),
      ...(thinkingSig ? { thinkingSig } : {}),
    });

    // 本轮正文已写完：这一轮的调用就出现在这个位置之后
    textSoFar += content;
    const results = await executeCalls(calls, textSoFar.length);
    /* 轮与轮之间空一行：消息正文是所有轮拼起来的，不留空行会粘成一坨。
       注意 textSoFar 要跟着加上这个分隔符 —— 否则下一轮卡片的偏移会差 2 个字符。 */
    if (content.trim()) {
      events.onContentDelta('\n\n');
      textSoFar += '\n\n';
    }

    for (const call of calls) {
      const r = results.get(call.id);
      history.push({
        role: 'tool',
        toolCallId: call.id,
        content: r ? r.text : '（无结果）',
        ...(r?.images?.length ? { images: r.images } : {}),
      });
    }
  }

  const rendered = events.render('loop.max_rounds');
  events.onNotice({ id: 'loop.max_rounds' }, rendered);
  const cap = finalText || '（达到轮次上限，运行结束）';
  if (!finalText) emitAside(cap);
  return { ok: true, aborted: false, rounds, finalText: cap };

  /* ────────── 工具执行：独占类串行，其余并行 ────────── */
  async function executeCalls(
    list: ToolCall[],
    at: number,
  ): Promise<Map<string, { ok: boolean; text: string; images?: Array<{ mime: string; data: string }> }>> {
    const out = new Map<string, { ok: boolean; text: string; images?: Array<{ mime: string; data: string }> }>();
    const jobs = list.map((call) => ({ call, seq: seq++ }));
    const serial = jobs.some((j) => input.isExclusive(j.call.name));
    if (serial || jobs.length === 1) {
      for (const j of jobs) out.set(j.call.id, await runGuarded(j.call, j.seq, at));
      return out;
    }
    const settled = await Promise.all(jobs.map((j) => runGuarded(j.call, j.seq, at)));
    jobs.forEach((j, i) => out.set(j.call.id, settled[i]!));
    return out;
  }

  async function runGuarded(
    call: ToolCall,
    n: number,
    at: number,
  ): Promise<{ ok: boolean; text: string; images?: Array<{ mime: string; data: string }> }> {
    const key = `${call.name}:${stableArgs(call.args)}`;
    const hits = repeatGuard.get(key) ?? 0;
    if (hits >= 2) {
      return { ok: false, text: `（同一调用已成功执行过 ${hits} 次，这次跳过。换一种做法，或直接汇报结论。）` };
    }
    const r = await input.runTool(call, n, at);
    if (r.ok) repeatGuard.set(key, hits + 1);
    return r;
  }
}

/**
 * 退避时长：指数增长 + ±20% 抖动（避免多个会话同时被限流时"齐步走"重试），
 * 并且**不低于上游要求的 Retry-After**。抖动只往上加，不会缩到 Retry-After 以下。
 */
function backoffMs(attempt: number, retryAfterMs: number): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = base * (1 + Math.random() * 0.4 - 0.2);
  return Math.max(retryAfterMs, Math.round(jittered));
}

function stableArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return String(args);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
