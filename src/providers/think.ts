/**
 * src/providers/think.ts —— 把正文里的 <think>…</think> 拆到思考通道。
 *
 * 从旧项目 agent/src/core/protocol/think.js 逐字移植（状态机逻辑一行未改，只把事件字段
 * `type` 换成契约的 `kind`，并补了返回类型）。
 *
 * 为什么需要：不是所有上游都会把思考过程单独放在 reasoning 字段里。实测（qwen3.8 走
 * OpenAI 兼容端点、未下发思考参数）它会**把 <think> 原文写进 content**，
 * 界面上表现为「思考面板空着、<think> 标签漏在回答气泡里」。
 *
 * 实测坑（原样保留）：标签可能被分词切开、跨 chunk 到达（`<thi` + `nk>`），
 * 所以每次都要把「最多 tag 长度-1」的尾巴留在缓冲里继续等；不闭合时 flush() 原样吐出，
 * 绝不静默吞内容。纯状态机，无副作用，可单测。
 */

/** 拆分产出的片段：思考 or 正文 */
export type ThinkChunk = { kind: 'thinking' | 'content'; text: string };

const OPEN = '<think>';
const CLOSE = '</think>';

export function thinkSplitter(): { feed(text: string): ThinkChunk[]; flush(): ThinkChunk[] } {
  let buf = '';
  let inThink = false;
  const step = (final: boolean): ThinkChunk[] => {
    const out: ThinkChunk[] = [];
    for (;;) {
      if (!inThink) {
        const i = buf.indexOf(OPEN);
        if (i === -1) {
          if (final) {
            if (buf) out.push({ kind: 'content', text: buf });
            buf = '';
            return out;
          }
          const keep = Math.min(buf.length, OPEN.length - 1);
          const cut = buf.length - keep;
          if (cut > 0) {
            out.push({ kind: 'content', text: buf.slice(0, cut) });
            buf = buf.slice(cut);
          }
          return out;
        }
        if (i > 0) out.push({ kind: 'content', text: buf.slice(0, i) });
        buf = buf.slice(i + OPEN.length);
        inThink = true;
      } else {
        const j = buf.indexOf(CLOSE);
        if (j === -1) {
          if (final) {
            if (buf) out.push({ kind: 'thinking', text: buf });
            buf = '';
            return out;
          }
          const keep = Math.min(buf.length, CLOSE.length - 1);
          const cut = buf.length - keep;
          if (cut > 0) {
            out.push({ kind: 'thinking', text: buf.slice(0, cut) });
            buf = buf.slice(cut);
          }
          return out;
        }
        if (j > 0) out.push({ kind: 'thinking', text: buf.slice(0, j) });
        buf = buf.slice(j + CLOSE.length);
        inThink = false;
      }
    }
  };
  return {
    feed: (chunk: string) => {
      buf += String(chunk == null ? '' : chunk);
      return step(false);
    },
    flush: () => step(true),
  };
}
