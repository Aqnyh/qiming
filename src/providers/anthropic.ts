/**
 * src/providers/anthropic.ts —— Anthropic Messages 协议适配器（api.anthropic.com/v1 或任何兼容网关）。
 *
 * 从旧项目 agent/src/core/protocol/anthropic.js 移植；传输同 openai.ts：适配器自己用全局 fetch 直连。
 *
 * 与 OpenAI 协议的三处结构差异（都在这里吸收掉，上层只认统一事件流）：
 *   ① system 是**顶层字段**，不是 messages 里的一条；
 *   ② 工具结果走 user 消息里的 tool_result 块，且 user/assistant 必须**严格交替**
 *      （并行工具调用的多条 tool_result、或滤掉空 assistant 后相邻的两条 user，都要合并）；
 *   ③ 流式事件是「带事件名的 SSE」（content_block_start/delta/stop、message_delta…），
 *      用 sse.ts 的 sseEvents 读（事件名兜底也来自它）。
 *
 * 移植时改了什么：
 *   · **扩展思考必须原样回传**：带 tool_use 的 assistant 轮里那只 thinking 块（含 signature）
 *     是上游校验的一部分——不回传就整轮 400。请求拼装侧完整保留（thinking + thinkingSig →
 *     {type:'thinking', signature}）。但**流式侧拿到的 signature_delta 在冻结的 StreamEvent 里
 *     没有对应事件**（旧项目是 thinking_sig），只能丢弃：上层要能回传签名，契约得补一个事件类型
 *     （见回复里的取舍说明）。redacted_thinking 同理（ChatMessage 没有该字段）。
 *   · max_tokens 缺省从旧实现的 4096 改成契约要求的 8192；thinking 预算仍夹到 max_tokens-1
 *     （旧审计 C5：预算写死 4096/8192/16384 而 max_tokens 默认 4096 时，一开推理强度就整轮 400）；
 *   · 相邻同角色合并从「只合并 user」扩到 user/assistant 都合并（契约要求严格交替）；
 *     空 assistant（无正文无调用）发出去必 400，按旧注释的意图先滤掉；
 *   · usage 取数改成合并 message_start（input_tokens）与 message_delta（output_tokens）——
 *     旧实现只留最后一次 usage，message_delta 里没有 input_tokens，用量会静默丢一半；
 *   · 事件流按新契约：旧的 stats → usage、stream_end 取消（收尾语义 = 见到 stop 事件）。
 */
import type {
  ChatFn, ChatMessage, ChatOptions, ListModelsFn, ProviderConfig, StreamEvent, ToolCall, ToolDef,
} from './types.ts';
import { parseToolArgs, sseEvents, stopReason } from './sse.ts';
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
/** 取参数：优先 camelCase（旧内核口径），回落 snake_case */
const pick = (p: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (p[k] !== undefined) return p[k];
  return undefined;
};

/* ============================ 线格式拼装 ============================ */

/** 内部消息 → Anthropic 线格式（工具结果包成 user 的 tool_result 块）
 *
 *  顺序有要求：thinking 必须在最前；signature 是上游给的完整性凭据，缺了就不能构造这个块
 *  （伪造一个只会换来另一种 400）——没有签名的历史（旧数据 / 从别的协议切过来）跳过，
 *  让请求至少能发出去。 */
export function toMsg(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
    const blocks: Array<Record<string, unknown>> = [];
    if (m.thinking && m.thinkingSig) blocks.push({ type: 'thinking', thinking: m.thinking, signature: m.thinkingSig });
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
    return { role: 'assistant', content: blocks };
  }
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          // 没图就继续用纯字符串（Anthropic 两种都收，字符串 payload 更小、也和旧行为一致）
          content: m.images?.length ? plainBlocks(m) : m.content,
        },
      ],
    };
  }
  // 有图就得用块数组，没图继续用纯字符串（改动面最小）
  return { role: m.role, content: m.images?.length ? plainBlocks(m) : m.content };
}

/** 一条消息的文本 + 图片块（Anthropic 的 image 块是 base64 source） */
function plainBlocks(m: ChatMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: m.content || '' }];
  for (const img of m.images ?? []) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
  }
  return blocks;
}

/** 内容统一成块数组（合并相邻同角色消息时用） */
function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) return content.filter(isObj);
  return [{ type: 'text', text: typeof content === 'string' ? content : '' }];
}

/** 合并相邻的同角色消息（Anthropic 要求严格交替，否则直接 400） */
function mergeAdjacent(msgs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && (m.role === 'user' || m.role === 'assistant')) {
      prev.content = contentBlocks(prev.content).concat(contentBlocks(m.content));
    } else {
      merged.push(m);
    }
  }
  return merged;
}

/** 契约工具定义 → Anthropic tools（把 function 摊平） */
export function toTools(tools: ToolDef[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools
    .filter((t) => Boolean(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
}

/** 推理强度 → 扩展思考预算（token） */
const THINK_BUDGET: Record<string, number> = { low: 4096, medium: 8192, high: 16384 };
/** 思考预算的最小可用值（Anthropic 要求 ≥1024） */
const MIN_THINK_BUDGET = 1024;
/** max_tokens 是必填项：缺省给 8192（契约要求；旧实现 4096 太小，开思考会被预算夹没） */
const DEFAULT_MAX_TOKENS = 8192;

export function buildBody(cfg: ProviderConfig, messages: ChatMessage[], opts: ChatOptions = {}): Record<string, unknown> {
  const p: Record<string, unknown> = opts.params ?? {};
  const tools = resolveTools(opts);
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const msgs = mergeAdjacent(
    messages
      .filter((m) => m.role !== 'system')
      // 空 assistant 发出去必 400；滤掉它之后相邻的两条 user 由 mergeAdjacent 合并
      .filter((m) => !(m.role === 'assistant' && !m.content && !(m.toolCalls && m.toolCalls.length)))
      .map((m) => toMsg(m)),
  );
  const maxTokensRaw = num(pick(p, 'maxTokens', 'max_tokens'));
  const maxTokens = maxTokensRaw !== undefined && maxTokensRaw > 0 ? maxTokensRaw : DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = { model: cfg.model, messages: msgs, stream: true, max_tokens: maxTokens };
  if (sys) body.system = sys;
  const stop = pick(p, 'stop');
  if (Array.isArray(stop) && stop.length) body.stop_sequences = stop.filter((s): s is string => typeof s === 'string');
  const reasoning = str(pick(p, 'reasoning'));
  const thinking = Boolean(reasoning) && reasoning !== 'default' && reasoning !== 'off';
  if (thinking) {
    /* Anthropic 硬约束：**max_tokens 必须大于 thinking.budget_tokens**，否则整轮 400。
       把预算压到 max_tokens-1 以内（且不低于 1024）；max_tokens 太小时干脆不开思考，
       让请求能正常发出——比 400 更接近用户想要的「能回答」。 */
    const budget = Math.min(THINK_BUDGET[reasoning] || 8192, maxTokens - 1);
    if (budget >= MIN_THINK_BUDGET) body.thinking = { type: 'enabled', budget_tokens: budget };
    // 开启扩展思考时 Anthropic 要求 temperature 必须为 1（否则 400），这里干脆不指定
  } else {
    const temperature = num(p.temperature);
    if (temperature !== undefined) body.temperature = temperature;
    const topP = num(pick(p, 'topP', 'top_p'));
    if (topP !== undefined) body.top_p = topP;
  }
  if (tools.length) body.tools = toTools(tools);
  return applyExtraBody(body, cfg.extraBody);
}

/** 本次请求的首部（鉴权 / 版本头 / 自定义头 / 会话标识头） */
export function buildHeaders(cfg: ProviderConfig, opts?: ChatOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': CLIENT_UA,
    'anthropic-version': '2023-06-01',
  };
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
  return mergeRequestHeaders(headers, cfg, opts);
}

/* ============================ 流式解析 ============================ */

type Usage = { input: number; output: number };

/** message_delta 只带 output_tokens，message_start 只带 input_tokens——合并而不是互相覆盖 */
function mergeUsage(cur: Usage | null, u: Record<string, unknown>): Usage {
  return {
    input: num(u.input_tokens) ?? cur?.input ?? 0,
    output: num(u.output_tokens) ?? cur?.output ?? 0,
  };
}

function toolCallOf(cur: { id: string; name: string }, jsonStr: string): ToolCall {
  const parsed = parseToolArgs(jsonStr);
  const call: ToolCall = { id: cur.id, name: cur.name, args: parsed.args };
  if (parsed.raw !== undefined) call.raw = parsed.raw;
  return call;
}

export const chat: ChatFn = async function* (cfg, messages, opts) {
  let url: string;
  try {
    url = joinUrl(cfg.baseUrl, '/messages');
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

  let usage: Usage | null = null;
  let cur: { id: string; name: string } | null = null;   // 正在累积的 tool_use 块
  let jsonStr = '';
  let sawStop = false;        // 见过 stop_reason / message_stop = 这次响应正常收尾
  let emittedStop = false;    // stop 事件已发（避免收尾重复补）
  /* 正文里「写成工具调用」的标记（DSML / XML）同样要认回来——有的兼容网关把
     tool_use 漏成 text_delta 下发，见 textcalls.ts。 */
  const tc = textCallSplitter();
  let streamError: { message: string; retryable: boolean; retryAfterMs?: number } | null = null;
  try {
    for await (const evt of sseEvents(r.body)) {
      let o: unknown;
      try {
        o = JSON.parse(evt.data);
      } catch {
        continue;
      }
      if (!isObj(o)) continue;
      const type = str(o.type) || evt.event;      // 官方事件类型在 data 里；event: 行作兜底
      if (type === 'error') {
        yield { kind: 'error', message: isObj(o.error) ? (str(o.error.message) || 'API error') : 'API error' };
        return;
      }
      if (type === 'message_stop') sawStop = true;
      if (type === 'message_start' && isObj(o.message) && isObj(o.message.usage)) {
        usage = mergeUsage(null, o.message.usage);
      }
      if (type === 'content_block_start' && isObj(o.content_block)) {
        const cb = o.content_block;
        if (cb.type === 'tool_use') {
          cur = { id: str(cb.id), name: str(cb.name) };
          jsonStr = '';
        }
        // redacted_thinking / 其它块：契约 ChatMessage 没有对应字段，跳过（见文件头）
      } else if (type === 'content_block_delta' && isObj(o.delta)) {
        const d = o.delta;
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
          yield { kind: 'thinking', text: d.thinking };
        } else if (d.type === 'signature_delta') {
          // 签名增量：上层累积后作为 thinkingSig 回传（缺了下一轮带 tool_use 的请求会 400）
          if (typeof d.signature === 'string' && d.signature) yield { kind: 'thinking_sig', sig: d.signature };
        } else if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          const r2 = tc.feed(d.text);
          if (r2.text) yield { kind: 'content', text: r2.text };
          if (r2.calls.length) yield { kind: 'tool_calls', calls: r2.calls };
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          jsonStr += d.partial_json;
        }
      } else if (type === 'content_block_stop' && cur) {
        yield { kind: 'tool_calls', calls: [toolCallOf(cur, jsonStr)] };
        cur = null;
        jsonStr = '';
      }
      if (type === 'message_delta') {
        if (isObj(o.usage)) usage = mergeUsage(usage, o.usage);
        if (isObj(o.delta) && typeof o.delta.stop_reason === 'string' && o.delta.stop_reason) {
          sawStop = true;
          emittedStop = true;
          yield { kind: 'stop', reason: stopReason(o.delta.stop_reason), clean: true };
        }
      }
    }
  } catch (e) {
    streamError = netError(e, cfg, opts?.signal);
  }
  /* 收尾：上游在 content_block_stop 之前断流时，正在累积的 tool_use 块别静默丢掉——
     与 openai.ts 的 `if (acc.size) yield takeCalls()` 同一道兜底。残缺参数会带 raw，
     交给上层的截断保护回绝（模型能看到「参数没给全」，而不是连调用都不存在）。 */
  if (cur) {
    yield { kind: 'tool_calls', calls: [toolCallOf(cur, jsonStr)] };
    cur = null;
    jsonStr = '';
  }
  const tail = tc.flush();      // 正文里没闭合的调用块（流结尾）也在这里结算
  if (tail.text) yield { kind: 'content', text: tail.text };
  if (tail.calls.length) yield { kind: 'tool_calls', calls: tail.calls };
  if (usage) yield { kind: 'usage', input: usage.input, output: usage.output };
  /* 收尾三态（同 openai.ts）：见过 stop_reason 已发过 stop；只见过 message_stop 补一个干净的；
     两者都没见过且无网络错 = 上游是断的 → clean:false，上层据此续跑。 */
  if (!streamError) {
    if (!emittedStop && sawStop) yield { kind: 'stop', reason: 'end_turn', clean: true };
    else if (!emittedStop && !sawStop) yield { kind: 'stop', reason: 'cut', clean: false };
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
  return ids.sort();
};
