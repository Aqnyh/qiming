/**
 * src/providers/openai.ts —— OpenAI 兼容协议适配器。
 *
 * 这一条协议同时覆盖：OpenAI、DeepSeek、硅基流动、Moonshot、智谱、OpenRouter、通义千问…
 * 以及本地 Ollama(/v1)、llama.cpp、vLLM、LM Studio、SGLang。**本地模型不另开协议分支。**
 *
 * 从旧项目 agent/src/core/protocol/openai.js 移植；传输从「浏览器 → 本站 /agent/upstream/*
 * 代转」改成「适配器自己用全局 fetch 直连上游」（密钥在 cfg.apiKey），因此旧 transport.js /
 * lib/agent/upstream.js 里属于传输的职责按需搬进了本文件或 index.ts。
 *
 * 移植时改了什么：
 *   · 事件流按新契约 types.ts 的 StreamEvent（thinking/content/tool_calls/usage/stop/error）：
 *     旧的 stats → usage（数字化）、stream_end 取消（正常收尾 = 收到 stop：finish_reason 或
 *     干净读到 [DONE] 时补一个 stop；两者都没有 = 半路被掐断，上层据此不当「回答完了」）；
 *   · 工具定义用契约的 ToolDef（name/description/schema），不再是 {function:{…}} 包一层；
 *   · safeJson 的 __badArgs 标记改成契约的 ToolCall.raw（见 sse.ts 的 parseToolArgs）；
 *   · 采样参数兼容 camelCase（旧内核口径）与 snake_case（契约注释口径）两种键名；
 *   · extraBody 在本层合并（旧实现是服务端的事）；echo_thinking 是本层控制开关，不外发；
 *   · 非 2xx / 网络错误 yield 一条 error 事件后 return，不 throw（唯一例外：listModels 仍抛，
 *     它的返回类型是 Promise<string[]>）；
 *   · 思考回传默认关闭：只有 cfg.extraBody.echo_thinking === true 才把历史 assistant 的 thinking
 *     拼成 reasoning_content（旧项目结论：两家在用的网关不强制回传，回传反而可能 400）。
 */
import type {
  ChatFn, ChatMessage, ChatOptions, ListModelsFn, ProviderConfig, StreamEvent, ToolCall, ToolDef,
} from './types.ts';
import { parseToolArgs, sseEvents, stopReason } from './sse.ts';
import { thinkSplitter } from './think.ts';
import type { ThinkChunk } from './think.ts';
import { textCallSplitter } from './textcalls.ts';
import {
  CLIENT_UA, applyExtraBody, isRetryableStatus, joinUrl, mergeRequestHeaders, netError, resolveTools, retryAfterMsOf, upstreamErrorText,
} from './index.ts';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** 取参数：优先 camelCase（旧内核口径），回落 snake_case（契约注释口径） */
const pick = (p: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (p[k] !== undefined) return p[k];
  return undefined;
};

/* ============================ 线格式拼装 ============================ */

/** 内部消息 → OpenAI 线格式 */
/**
 * 带图消息 → OpenAI 的 content 数组（data URL）。
 * 没图就保持纯字符串：多数网关对"字符串 content"最宽容，能不升级就不升级。
 */
function contentOf(m: ChatMessage): unknown {
  if (!m.images?.length) return m.content;
  return [
    { type: 'text', text: m.content || '' },
    ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })),
  ];
}

export function toMsg(m: ChatMessage, echoThinking = false): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
    const out: Record<string, unknown> = {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      })),
    };
    if (echoThinking && m.thinking) out.reasoning_content = m.thinking;
    return out;
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: contentOf(m) };
  const out: Record<string, unknown> = { role: m.role, content: contentOf(m) };
  if (m.role === 'assistant' && echoThinking && m.thinking) out.reasoning_content = m.thinking;
  return out;
}

/** 契约工具定义 → OpenAI tools（两边形状本来就是同一个意思，只做字段筛选） */
export function toTools(tools: ToolDef[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools
    .filter((t) => Boolean(t.name))
    .map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
}

/** 请求体构造（契约参数 → 线格式） */
export function buildBody(cfg: ProviderConfig, messages: ChatMessage[], opts: ChatOptions = {}): Record<string, unknown> {
  const p: Record<string, unknown> = opts.params ?? {};
  const tools = resolveTools(opts);
  const echoThinking = cfg.extraBody?.echo_thinking === true;
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map((m) => toMsg(m, echoThinking)),
    stream: true,
    stream_options: { include_usage: true },
  };
  const temperature = num(p.temperature);
  if (temperature !== undefined) body.temperature = temperature;
  const topP = num(pick(p, 'topP', 'top_p'));
  if (topP !== undefined) body.top_p = topP;
  const maxTokens = num(pick(p, 'maxTokens', 'max_tokens'));
  if (maxTokens !== undefined && maxTokens >= 0) body.max_tokens = maxTokens;
  const stop = pick(p, 'stop');
  if (Array.isArray(stop) && stop.length) body.stop = stop.filter((s): s is string => typeof s === 'string');
  const seed = pick(p, 'seed');
  if (seed !== undefined) body.seed = seed;
  const topK = pick(p, 'topK', 'top_k');
  if (topK !== undefined) body.top_k = topK;
  const freqPenalty = pick(p, 'freqPenalty', 'frequency_penalty');
  if (freqPenalty !== undefined) body.frequency_penalty = freqPenalty;
  const presPenalty = pick(p, 'presPenalty', 'presence_penalty');
  if (presPenalty !== undefined) body.presence_penalty = presPenalty;
  const reasoning = str(pick(p, 'reasoning'));
  if (reasoning && reasoning !== 'default') {
    body.reasoning_effort = reasoning === 'off' ? 'none' : reasoning;
  }
  // tools 为空时**不发 tools 字段**（有的上游见到空数组直接 400）
  if (tools.length) {
    body.tools = toTools(tools);
    body.tool_choice = 'auto';
  }
  return applyExtraBody(body, cfg.extraBody);
}

/** 本次请求的首部（鉴权 / 自定义头 / 会话标识头） */
export function buildHeaders(cfg: ProviderConfig, opts?: ChatOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': CLIENT_UA,
  };
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
  return mergeRequestHeaders(headers, cfg, opts);
}

/* ============================ 流式解析 ============================ */

type CallAcc = Map<number, { id: string; name: string; argsStr: string }>;

/** 累积一条 delta 里的工具调用分片（按 index 还原顺序） */
function absorbCalls(list: unknown[], acc: CallAcc): void {
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const i = num(raw.index) ?? 0;
    const cur = acc.get(i) ?? { id: '', name: '', argsStr: '' };
    if (typeof raw.id === 'string' && raw.id) cur.id = raw.id;
    const fn = isObj(raw.function) ? raw.function : null;
    if (fn) {
      if (typeof fn.name === 'string' && fn.name) cur.name = fn.name;
      if (typeof fn.arguments === 'string') cur.argsStr += fn.arguments;
    }
    acc.set(i, cur);
  }
}

/** 流式解析：把 SSE 逐块翻译成统一事件流 */
export const chat: ChatFn = async function* (cfg, messages, opts) {
  let url: string;
  try {
    url = joinUrl(cfg.baseUrl, '/chat/completions');
  } catch (e) {
    yield { kind: 'error', message: `${e instanceof Error ? e.message : String(e)}：${cfg.baseUrl || '(空)'}`, retryable: false };
    return;
  }
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(cfg, opts),
      body: JSON.stringify(buildBody(cfg, messages, opts)),
      signal: opts?.signal,
    });
  } catch (e) {
    const ne = netError(e, cfg, opts?.signal);
    yield { kind: 'error', message: ne.message, retryable: ne.retryable };
    return;
  }
  if (!r.ok) {
    yield {
      kind: 'error',
      message: await upstreamErrorText(r),
      retryable: isRetryableStatus(r.status),
      retryAfterMs: retryAfterMsOf(r),
    };
    return;
  }
  if (!r.body) {
    yield { kind: 'error', message: '上游返回了空响应体（无法流式读取）', retryable: true };
    return;
  }

  const acc: CallAcc = new Map();
  const takeCalls = (): ToolCall[] =>
    [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => {
        const parsed = parseToolArgs(c.argsStr);
        const call: ToolCall = { id: c.id || 'call_' + i + '_' + Date.now(), name: c.name, args: parsed.args };
        if (parsed.raw !== undefined) call.raw = parsed.raw;
        return call;
      });
  const split = thinkSplitter();
  /* 有的上游不把工具调用放进 delta.tool_calls，而是**写进正文**（DSML 标记 / XML 形态，见 textcalls.ts）：
     正文一律再过一道「正文调用」拆分器，认出来的变成结构化 tool_calls、认不出的原样当正文。 */
  const tc = textCallSplitter();
  const bodyOut = (chunks: ThinkChunk[]): StreamEvent[] => {
    const out: StreamEvent[] = [];
    for (const ev of chunks) {
      if (ev.kind === 'thinking') out.push({ kind: 'thinking', text: ev.text });
      else {
        const r2 = tc.feed(ev.text);
        if (r2.text) out.push({ kind: 'content', text: r2.text });
        if (r2.calls.length) out.push({ kind: 'tool_calls', calls: r2.calls });
      }
    }
    return out;
  };

  /* 这条流的「结束形态」：见过 finish_reason 或 [DONE] = 上游正常收尾；两者都没见过 = 半路被掐断
     （旧 stream_end clean 语义在新契约里的落点：干净收尾时一定有 stop 事件）。 */
  let sawDone = false;
  let sawFinish = false;
  let streamError: { message: string; retryable: boolean; retryAfterMs?: number } | null = null;
  try {
    for await (const evt of sseEvents(r.body)) {
      const data = evt.data.trim();
      if (data === '[DONE]') {
        sawDone = true;
        break;
      }
      let o: unknown;
      try {
        o = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isObj(o)) continue;
      if (o.error !== undefined) {
        yield { kind: 'error', message: isObj(o.error) ? (str(o.error.message) || JSON.stringify(o.error)) : String(o.error) };
        return;
      }
      const choices = Array.isArray(o.choices) ? o.choices : [];
      const ch = isObj(choices[0]) ? choices[0] : null;
      if (ch) {
        const d = isObj(ch.delta) ? ch.delta : {};
        const think = d.reasoning_content !== undefined ? d.reasoning_content : d.reasoning;
        if (typeof think === 'string' && think) yield { kind: 'thinking', text: think };
        if (typeof d.content === 'string' && d.content) {
          for (const ev of bodyOut(split.feed(d.content))) yield ev;
        }
        if (Array.isArray(d.tool_calls)) absorbCalls(d.tool_calls, acc);
        const finish = str(ch.finish_reason);
        if (finish) {
          sawFinish = true;
          yield { kind: 'stop', reason: stopReason(finish), clean: true };
          // finish_reason 一到，分片累积的调用就不等收尾了（tool_calls 是常见的一种收尾）
          if (finish === 'tool_calls' && acc.size) {
            yield { kind: 'tool_calls', calls: takeCalls() };
            acc.clear();
          }
        }
      }
      if (isObj(o.usage)) {
        yield { kind: 'usage', input: num(o.usage.prompt_tokens) ?? 0, output: num(o.usage.completion_tokens) ?? 0 };
      }
    }
  } catch (e) {
    streamError = netError(e, cfg, opts?.signal);
  }
  // 兜底：有些服务商不发 finish_reason 就结束；半路断流也要把缓冲结算掉
  for (const ev of bodyOut(split.flush())) yield ev;
  const tail = tc.flush();
  if (tail.text) yield { kind: 'content', text: tail.text };
  if (tail.calls.length) yield { kind: 'tool_calls', calls: tail.calls };
  if (acc.size) yield { kind: 'tool_calls', calls: takeCalls() };
  /* 收尾标记三态（必须区分"回答完了"与"半路被掐"，见 types.ts 的 clean）：
     · 见过 finish_reason：上面已经发过 stop(clean:true)；
     · 只见过 [DONE]：补一个 stop(clean:true)；
     · 两个都没见过且没有网络错：**上游是断的** → stop(clean:false)，上层据此续跑而不是当最终回答。 */
  if (!streamError) {
    if (!sawFinish && sawDone) yield { kind: 'stop', reason: 'stop', clean: true };
    else if (!sawFinish && !sawDone) yield { kind: 'stop', reason: 'cut', clean: false };
  }
  if (streamError) {
    yield { kind: 'error', message: streamError.message, retryable: streamError.retryable, retryAfterMs: streamError.retryAfterMs };
  }
};

/* ============================ 模型清单 ============================ */

export const listModels: ListModelsFn = async (cfg, signal) => {
  const url = joinUrl(cfg.baseUrl, '/models');
  const r = await fetch(url, { method: 'GET', headers: buildHeaders(cfg), signal });
  if (!r.ok) throw new Error(await upstreamErrorText(r));
  const d: unknown = await r.json();
  const ids: string[] = [];
  const data = isObj(d) && Array.isArray(d.data) ? d.data : [];
  for (const it of data) {
    if (isObj(it) && typeof it.id === 'string' && it.id) ids.push(it.id);
  }
  // 有的兼容实现把清单放在 models 字段（Ollama 的 /v1/models 是 data，但网关类五花八门）
  if (!ids.length && isObj(d) && Array.isArray(d.models)) {
    for (const it of d.models) {
      if (!isObj(it)) continue;
      const v = it.name ?? it.id;
      if (typeof v === 'string' && v) ids.push(v);
    }
  }
  return ids.sort();
};
