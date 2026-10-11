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
import type { ModelParams, SystemSettings } from '../store/settings.ts';
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
  /**
   * turn = 由**用户输入**划出的一段（一次提问 / 一次插话 = 新的 turn）；
   * step = 由**一次模型调用**划出的一步（工具回灌后再算下一步）。
   *
   * 为什么分开：`round` 一个数此前扛了所有事 —— "用户又插了一句"和"模型又调了一次工具"
   * 在界面上分不清。分开后插话挂靠点清晰（steer/urgent 注入即开新 turn、step 归零），
   * 与主流 harness（dsh 的 turn/step）对齐。
   */
  turn: number;
  step: number;
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
  /** 取出待注入的用户插话（安全点调用：模型调用后 / 每次工具调用返回后 / 工具批次后） */
  takeSteering: () => string[];
  /** 取出"打断"的话（掐掉当前调用或工具之后立刻注入） */
  takeUrgent: () => string[];
  /** 每次模型调用开始：宿主拿到中断把手（用户点「打断」时掐掉这一次调用） */
  onCallStart?: (ac: AbortController) => void;
  /** 每次工具调用开始：宿主拿到"掐这个工具"的把手（打断语义要连工具一起掐） */
  onToolStart?: (ac: AbortController) => void;
  /** 渲染循环文案 */
  render: (id: string, vars?: Record<string, string>) => string;
};

export type LoopInput = {
  cfg: ProviderConfig;
  /** 模型调用参数（temperature/maxTokens/超时/重试…），设置 → 模型 */
  params: ModelParams;
  /** 系统参数（停滞看门狗/自动续跑…），设置 → 系统 */
  sys: SystemSettings;
  system: string;
  /** 请求视图（本函数会往里追加本轮产生的消息） */
  history: ChatMessage[];
  tools: ToolDef[];
  maxRounds: number;
  /**
   * 执行一次工具调用。`at` = 这次调用出现在正文里的字符偏移（本轮正文写完时的累计长度）——
   * 宿主拿它记进调用记录，界面据此把媒体/文件卡插到正确的位置。
   * `toolSignal` 是**这一个工具**的掐断把手（用户打断时宿主掐它，与整段运行的 signal 分开：
   * 掐断不该把整段运行判死，见 loop.ts 的 executeTools）。
   */
  runTool: (
    call: ToolCall,
    seq: number,
    at: number,
    toolSignal: AbortSignal,
  ) => Promise<ToolExecResult>;
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

/** 一次工具调用的结果（走 host 的 runTool） */
type ToolExecResult = { ok: boolean; text: string; images?: Array<{ mime: string; data: string }>; errorCode?: string };

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const { cfg, params, sys, events, log, signal } = input;
  const history = input.history;
  let seq = 0;
  let nudges = 0;
  const maxRetries = Math.max(0, Number(params.retryCount ?? 2));
  let retriesLeft = maxRetries;
  /** 自动续跑（默认关）：重试预算用完后还接着试几次，让"上游抽风"不需要人工再发一句 */
  const maxAutoContinues = sys.autoContinue ? Math.max(0, Number(sys.autoContinueMax ?? 2)) : 0;
  let autoContinuesLeft = maxAutoContinues;
  /** 停滞看门狗：这么久没有任何字节就中止本次调用（0 = 关） */
  const stallSec = Math.max(0, Number(sys.stallSec ?? 90));
  let interruptStreak = 0;
  let truncStreak = 0;
  let finalText = '';
  /**
   * turn/step 计数（见 RoundInfo 的说明）：
   *  · turn 在**用户输入**处 +1（开跑算 turn 1；每次插话/打断注入算新的一 turn）；
   *  · step 是当前 turn 内的模型调用序号。
   * 两者都随事件发出去，界面既能显示"总共第几步"，也能显示"这一段里的第几步"。
   */
  let turn = 1;
  let stepInTurn = 0;
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

    stepInTurn += 1;

    // 1) 插话注入（用户在上一步运行中说的事）—— 插话 = 开一个新的 turn
    const startSteering = events.takeSteering();
    for (const text of startSteering) {
      const rendered = events.render('loop.steering', { text });
      history.push({ role: 'user', content: rendered });
      events.onNotice({ id: 'loop.steering', vars: { text } }, rendered);
    }
    if (startSteering.length) {
      turn += 1;
      stepInTurn = 1;
    }

    /* 请求前的历史自愈（幂等）：畸形序列会让上游**整段请求** 400，
       而症状只是一句莫名其妙的错误文案，极难归因。宁可在发出去之前修好。 */
    const repaired = repairHistory(history);
    if (repaired) log.warn('历史里有畸形消息序列，已自愈后再发请求', { repaired });

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

    events.onRound({ round, turn, step: stepInTurn, content, thinking, calls, stop: stop ?? 'cut', usage, ms, aborted });

    if (aborted) return { ok: false, aborted: true, rounds: round, finalText: finalText || content };

    /* ★ 打断（urgent）优先于一切后续处理：
       用户点了「打断」，服务端掐掉了上面这次调用 —— 不执行（可能不完整的）工具调用、
       不按超时/报错处理，直接把已经生成的内容留档，注入新指令，马上开下一轮。
       这是 Codex 的 interrupt / Claude Code 里"Esc + 新指令"的等价物。 */
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
      turn += 1; // 用户打断 = 新的 turn
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
        /* ★ 插话安全点：**模型调用之后**。
           用户在模型出字期间补的那句话，在这里注入 —— 不打断已经吐完的这一轮，
           但也不让它成为"最终回答"（否则用户的话要等下一段运行才有人理，那就成了"排队"）。
           注入后 continue：下一轮模型就能看到新指令。 */
        if (injectSteering()) {
          history.push({ role: 'assistant', content });
          nudges = 0;
          continue;
        }
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
      /* ★ 截断的这批调用**不执行**，但 assistant 消息里的 toolCalls 必须逐个有对应的 tool 结果，
         否则下一轮请求就是「带 tool_calls 却无配对」的畸形历史 → 上游直接 400
         （实测 opencode 网关回 {"model":"…"}，见 2026-10-10 的复盘）。
         这里补的是"没执行"的说明，既满足配对约束，也让模型知道这批调用没跑。 */
      for (const call of calls) {
        history.push({ role: 'tool', toolCallId: call.id, content: '（上一轮输出被截断，这次调用没有执行。请把参数拆小重新发起。）' });
      }
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
    const { results, urgent: urgentDuringTools } = await executeTools(calls, textSoFar.length);
    if (urgentDuringTools.length) {
      /* 工具跑到一半被用户打断：把**已经执行过的**工具结果留在历史里（模型需要知道
         "哪些做了、哪些没做"），然后把新指令插进来，立刻开下一轮。

         ⚠️ 上面第 5 步（本分支之前）**已经 push 过一条带 toolCalls 的 assistant**，
         这里绝不能再 push 一遍 —— 两条同 id 的 tool_calls 会拼出畸形历史，上游直接 400
         （实测 opencode 网关回 {"model":"…"}；2026-10-10 那次运行就是这么终结的）。 */
      for (const call of calls) {
        const r = results.get(call.id);
        history.push({ role: 'tool', toolCallId: call.id, content: r ? r.text : '（用户打断，这次调用没有执行。）', ...(r?.images?.length ? { images: r.images } : {}) });
      }
      /* 打断的那一批工具**不再算作正文的一部分**（下面给正文补的分隔符也不加了）：
         它们的结果是"被打断"的残局，接在正文后面只会让叙述断裂。 */
      for (const text of urgentDuringTools) {
        const rendered = events.render('loop.steering_urgent', { text });
        history.push({ role: 'user', content: rendered });
        events.onNotice({ id: 'loop.steering_urgent', vars: { text } }, rendered);
      }
      nudges = 0;
      turn += 1; // 工具批次中被打断 = 新的 turn
      continue;
    }
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

  /**
   * 执行一批工具调用。
   *
   * 这里有两个**安全点**，都是插话语义的落点：
   *   1. 批内串行跑时，**每次工具返回后**注入（用户在两分钟的命令跑到一半时补的那句话，
   *      下一件工具就能按新方向做 —— 不用等整批跑完）。并行批次没有中间态，只在批后注入。
   *   2. 批后注入（所有工具都跑完）。
   * 打断（urgent）会掐掉正在跑的工具，并把它的结果标成"被用户打断"，模型看得到。
   */
  async function executeTools(
    list: ToolCall[],
    at: number,
  ): Promise<{
    results: Map<string, ToolExecResult>;
    /** 批次里发生的打断：非空表示用户掐了这次运行，调用方要立刻转向 */
    urgent: string[];
  }> {
    const results = new Map<string, ToolExecResult>();
    const jobs = list.map((call) => ({ call, seq: seq++ }));
    const serial = jobs.some((j) => input.isExclusive(j.call.name));
    /** 打断工具用：正在跑的那个工具的掐断把手 */
    let currentTool: AbortController | null = null;
    /** 打断时取走的文本 */
    const pendingUrgent: string[] = [];

    const runOne = async (job: { call: ToolCall; seq: number }): Promise<void> => {
      const ac = new AbortController();
      currentTool = ac;
      events.onToolStart?.(ac);
      try {
        results.set(job.call.id, await runGuarded(job.call, job.seq, at, ac.signal));
      } finally {
        currentTool = null;
      }
    };

    /** 有打断就掐掉正在跑的工具并记下来 */
    const takeUrgent = (): boolean => {
      const urgent = events.takeUrgent();
      if (!urgent.length) return false;
      pendingUrgent.push(...urgent);
      currentTool?.abort();
      return true;
    };

    /** 还没跑的调用直接作废：告诉模型"这些没执行"，免得它以为做过 */
    const voidPending = (): void => {
      for (const pending of jobs) {
        if (!results.has(pending.call.id)) {
          results.set(pending.call.id, { ok: false, errorCode: 'ABORTED_BEFORE_DISPATCH', text: '（用户打断，这次调用没有执行。）' });
        }
      }
    };

    if (serial || jobs.length === 1) {
      for (const job of jobs) {
        if (takeUrgent()) {
          voidPending();
          return { results, urgent: pendingUrgent };
        }
        await runOne(job);
        // ★ 串行批内的安全点：这件工具刚跑完，插话立刻注入（下一次模型调用就能看到）
        if (injectSteering()) return { results, urgent: [] };
      }
      return { results, urgent: [] };
    }

    // 并行批：先看有没有已到的打断；跑完再统一注入（并行批没有中间态可以插）
    if (takeUrgent()) {
      voidPending();
      return { results, urgent: pendingUrgent };
    }
    await Promise.all(jobs.map((j) => runOne(j)));
    injectSteering();
    return { results, urgent: [] };
  }

  /**
   * 取走 steer 插话并注入历史（安全点的统一动作）。
   * @returns 有没有注入
   */
  function injectSteering(): boolean {
    const texts = events.takeSteering();
    if (!texts.length) return false;
    for (const text of texts) {
      const rendered = events.render('loop.steering', { text });
      history.push({ role: 'user', content: rendered });
      events.onNotice({ id: 'loop.steering', vars: { text } }, rendered);
    }
    turn += 1; // 插话 = 新的 turn（下一次模型调用就该算新 turn 的第 1 步）
    return true;
  }

  async function runGuarded(
    call: ToolCall,
    n: number,
    at: number,
    toolSignal: AbortSignal,
  ): Promise<ToolExecResult> {
    const key = `${call.name}:${stableArgs(call.args)}`;
    const hits = repeatGuard.get(key) ?? 0;
    if (hits >= 2) {
      return { ok: false, errorCode: 'LOOP_GUARD', text: `（同一调用已成功执行过 ${hits} 次，这次跳过。换一种做法，或直接汇报结论。）` };
    }
    const r = await input.runTool(call, n, at, toolSignal);
    if (r.ok) repeatGuard.set(key, hits + 1);
    return r;
  }
}

/**
 * 请求前的**历史自愈**：把畸形消息序列修正成上游能接受的样子。
 *
 * 为什么必须做这道闸门（2026-10-10 实战教训）：
 * 一次「工具跑到一半被用户打断」的运行，历史里落进了**两条同 id 的 assistant(tool_calls)**
 * （循环的打断分支重复 push），下一轮请求被网关判为畸形，回了 `HTTP 400 {"model":"…"}`
 * —— 错误文案里没有一个字提到"消息序列"，整段运行就此终结，极难归因。
 * 补丁修掉了产生方，但**旧会话已经落盘的历史还在**，且未来仍可能有别的路径写歪，
 * 所以这里再加一道幂等闸门：发出去之前必须自洽。
 *
 * 修的三件事（都是 openai 兼容协议里明确禁止、对着 opencode 网关实测必 400 的形态）：
 *  1. assistant 带 toolCalls → 其后必须紧跟这批调用**全部**的 tool 结果；缺的补"没执行"，
 *     多出来的孤儿 tool 消息删掉；
 *  2. tool_call id 不能重复（同一条消息内重复 / 跨消息撞车都算）；
 *  3. 空 assistant（既没正文也没调用）发出去必 400，删掉。
 *
 * ⚠️ **不要**顺手合并相邻的同角色消息。实测（2026-10-10，对真实网关）：
 * 「连续两条 user」「相邻两条 assistant」都返回 200，根本不是问题；
 * 而合并会把循环注入的重试/续跑提示跟用户原话搅在一起，破坏"按消息形态判定场景"的逻辑
 * （e2e 的 429 重试用例就是这么被误伤的）。自愈只修**确证会 400** 的形态。
 *
 * @returns 修正了几处（0 = 历史本来就干净）
 */
export function repairHistory(history: ChatMessage[]): number {
  let fixed = 0;
  const out: ChatMessage[] = [];
  /** 已经声明过 tool_calls id 的集合（跨消息判重：同 id 出现两次也是畸形） */
  const usedCallIds = new Set<string>();

  for (let i = 0; i < history.length; i++) {
    const m = history[i];

    /* ① assistant 的 tool_calls：去重 id + 补齐 tool 结果 */
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls: ToolCall[] = [];
      for (const c of m.toolCalls) {
        // 同一条消息里重复的 id、或历史里已经用过的 id → 只留第一份
        if (!c.id || usedCallIds.has(c.id)) {
          fixed += 1;
          continue;
        }
        usedCallIds.add(c.id);
        calls.push(c);
      }

      /* 后面必须紧跟这批调用的全部 tool 结果；跟到别的消息就说明缺了 */
      const ids = new Set(calls.map((c) => c.id));
      let j = i + 1;
      const tools: ChatMessage[] = [];
      while (j < history.length && history[j].role === 'tool') {
        const t = history[j];
        if (t.toolCallId && ids.has(t.toolCallId)) {
          ids.delete(t.toolCallId);
          tools.push(t);
        } else {
          fixed += 1; // 孤儿 tool 结果（没有对应调用）→ 丢
        }
        j += 1;
      }
      i = j - 1;

      /* 调用被去重光了、正文也空 → 这条 assistant 整个没意义，别留着惹上游 */
      if (!calls.length && !m.content.trim()) {
        fixed += 1;
        continue;
      }
      out.push(calls.length ? { ...m, toolCalls: calls } : { ...m, toolCalls: undefined });
      out.push(...tools);
      for (const missing of ids) {
        out.push({ role: 'tool', toolCallId: missing, content: '（这次调用没有执行。）' });
        fixed += 1;
      }
      continue;
    }

    /* ② 孤立的 tool 消息（前面没有带对应调用的 assistant）→ 丢 */
    if (m.role === 'tool') {
      if (!m.toolCallId || !usedCallIds.has(m.toolCallId)) {
        fixed += 1;
        continue;
      }
      out.push(m);
      continue;
    }

    /* ③ 空 assistant（既没正文也没调用）发出去必 400 → 丢 */
    if (m.role === 'assistant' && !m.content.trim() && !m.toolCalls?.length) {
      fixed += 1;
      continue;
    }

    out.push(m);
  }

  if (fixed) {
    history.length = 0;
    history.push(...out);
  }
  return fixed;
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
