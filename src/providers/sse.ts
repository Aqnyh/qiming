/**
 * src/providers/sse.ts —— SSE / 流式读取的底层工具（只做「字节 → 事件」，不认识任何模型厂商）。
 *
 * 从旧项目 agent/src/core/protocol/sse.js 移植（只取「字节 → SSE 事件」这一段 + 两个与协议无关的小函数）。
 * 三条实测兜底原样保留（旧文件头的 ①②③）：
 *   ① 按「一个 data: 行一个事件」分帧会静默丢内容：多个 data: 行要按 SSE 规范以 \n 拼接；
 *      行尾的 \r 必须先剥掉，否则 JSON.parse 失败；
 *   ② 上游压根不用空行分隔事件（不合规范但确实存在）→ 退化成按行处理，流式不中断；
 *   ③ 上游没以空行结尾时，缓冲区里剩下的最后一帧常常正是带 stop_reason 的那一帧，必须吐出来。
 *
 * 移植时改了什么：
 *   · 入口从 Response 改成契约里的 ReadableStream<Uint8Array>（fetch/请求头/超时/abort 归各自的适配器，
 *     这里保持纯粹）；转发/看门狗逻辑一律不移植——空闲超时由上层 loop 负责（2026-10-10 决定）；
 *   · 旧 sseLines（OpenAI 风格「逐条 data」）不移植：OpenAI 适配器直接消费本文件的 sseEvents，
 *     `[DONE]` 由适配器自己识别（事件名可空，行为与旧 sseLines 等价）；
 *   · stopReason / 参数解析两个小函数是旧 sse.js 同源移植，但参数解析改用契约的 ToolCall.raw
 *     表达「JSON 没解析出来」（旧的 __badArgs 标记没有了）。
 */

/** 一个 SSE 事件块：事件名可空（OpenAI 风格没有 event: 行）；data 已按 SSE 规范拼接好 */
export type SseEvent = { event: string; data: string };

/** 把缓冲区切出完整的 SSE 事件块（块之间以空行分隔；兼容 \r\n\r\n） */
function takeSseBlocks(buf: string): [string[], string] {
  const blocks: string[] = [];
  const re = /\r?\n\r?\n/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    blocks.push(buf.slice(0, m.index));
    buf = buf.slice(m.index + m[0].length);
  }
  return [blocks, buf];
}

/** 从事件块里取 data（SSE 规范：多个 data: 行以 \n 拼接，且只去掉一个前导空格） */
function blockData(block: string): string {
  let data = '';
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
  }
  return data;
}

/** 从事件块里取事件名（event: 行；取最后一个，容忍空块） */
function blockEvent(block: string): string {
  let event = '';
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) event = line.slice(6).trim();
  }
  return event;
}

function parseBlock(block: string): SseEvent {
  return { event: blockEvent(block), data: blockData(block) };
}

/**
 * 带事件名的 SSE（Anthropic 风格：event: xxx + data: {...}；OpenAI 风格同样可用，事件名为空串）。
 *
 * 三条实测兜底都在这里：① 空行分帧兼容 \r\n；② 上游不用空行分隔 → 退化按行（流式不中断）；
 * ③ 流末尾剩下的最后一帧照样吐（常常正是带 stop_reason 的那一帧）。
 * 消费方 return / 抛错时，finally 会 cancel 读端（用户点「停止」时尤其重要：不 cancel 连接一直挂着）。
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const [blocks, rest] = takeSseBlocks(buf);
      const hadBlock = blocks.length > 0;
      buf = rest;
      for (const block of blocks) {
        const ev = parseBlock(block);
        if (ev.data) yield ev;
      }
      if (!hadBlock && buf.includes('\n')) {
        // 兜底②：上游不用空行分隔事件。退化成按行处理，流式不中断。
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const raw of parts) {
          const ev = parseBlock(raw);
          if (ev.data) yield ev;
        }
      }
    }
    // 兜底③：收尾——剩下的最后一帧照样吐出来
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev.data) yield ev;
    }
  } finally {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* 已断开 */
    }
  }
}

/** 各家对「输出被 token 上限截断」的叫法不同，统一成 'length'（上层截断保护据此判断） */
export function stopReason(reason: string): string {
  return reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens' ? 'length' : reason || '';
}

const RAW_CLIP = 200;

/** 截断保护用的原文片段（与旧 safeJson 的 __raw 同一口径） */
function clipRaw(raw: string): string {
  return raw.length > RAW_CLIP ? raw.slice(0, RAW_CLIP) + '…' : raw;
}

/**
 * 工具参数文本 → { args, raw? }。旧 sse.js 的 safeJson 移植，但失败信号改用契约的 ToolCall.raw：
 *   · 解析成功且是普通对象 → args；
 *   · 空串 → 空参数（工具本来就不要参数）；
 *   · 解析失败 / 解析出来不是对象（被截断的半截 JSON、数组、字面量）→ args 保底 {}，raw 留截断原文。
 * 旧实现用 `__badArgs` 让内核分辨「参数没拼完」，新契约没有这个字段——raw 在 = 参数不可信，
 * 上层截断保护据此回绝调用（模型能看到「参数没给全」，而不是照着空参数去执行）。
 */
export function parseToolArgs(text: string | null | undefined): { args: Record<string, unknown>; raw?: string } {
  const s = String(text ?? '').trim();
  if (!s) return { args: {} };
  try {
    const v: unknown = JSON.parse(s);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return { args: v as Record<string, unknown> };
  } catch {
    /* 落到 raw */
  }
  return { args: {}, raw: clipRaw(s) };
}
