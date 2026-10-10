/**
 * ui/lib/message-parts.js —— 把一条助手消息切成"正文 + 该位置的附件"，按模型发出的顺序渲染。
 *
 * 为什么需要它：模型一轮里可能"先说一句话 → 发一张图 → 再说一句 → 再发一段视频"。
 * 如果渲染时把整段正文先画完、再把所有媒体堆在末尾，顺序就丢了（用户报的问题）。
 * 主流 harness（Claude Code 等的转录）都是**按顺序逐个渲染各个部分**，而不是合并成一大块。
 *
 * 位置从哪来：服务端给每次工具调用记了 `contentAt`（本轮正文写完时的累计字符偏移），
 * 于是正文可以在这些位置切开，卡片正好落在"模型说那句话之后"。
 *
 * 用户插话**不在这里**：插话不进消息区（它由循环注入的浅文字提示呈现，见 Message.jsx 的
 * notices —— 那是唯一呈现方式，避免同一句话在界面上出现两遍）。
 *
 * 纯函数（不碰 DOM），所以能直接单测。
 */

/** 一条调用要不要产出可见的附件（媒体卡 / 文件卡） */
function hasCards(call) {
  return Boolean(call && ((Array.isArray(call.media) && call.media.length) || (Array.isArray(call.files) && call.files.length)));
}

/**
 * @param content 消息正文（所有轮的叙述拼在一起）
 * @param calls   这条消息的调用记录（带 contentAt）
 * @returns [{ text, calls }] —— 依次渲染：先 text（Markdown），再这些 calls 的媒体/文件卡
 *
 * 没有附件的调用（绝大多数：读文件、跑命令）不参与切段 —— 它们只出现在折叠的追踪条里，
 * 不该把正文切得七零八落。
 */
export function buildParts(content, calls) {
  const text = String(content ?? '');
  const withCards = (calls ?? []).filter(hasCards);
  if (!withCards.length) return [{ text, calls: [] }];

  const clamp = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return text.length; // 老记录没有 contentAt：按"放在末尾"处理（保持旧观感）
    return Math.max(0, Math.min(Math.trunc(v), text.length));
  };

  const points = [...new Set(withCards.map((c) => clamp(c.contentAt)))].sort((a, b) => a - b);
  const parts = [];
  let prev = 0;
  for (const p of points) {
    parts.push({ text: text.slice(prev, p), calls: withCards.filter((c) => clamp(c.contentAt) === p) });
    prev = p;
  }
  parts.push({ text: text.slice(prev), calls: [] });
  return parts;
}

/**
 * 消息区要渲染的对话消息。
 *
 * **插话（steer）被排除**：它在界面上的唯一呈现是循环注入的浅文字提示
 * （"用户在运行中补充了说明…"，随助手消息的 notices 落盘），
 * 再画一个气泡就成了同一句话显示两遍（用户明确要求不显示在消息框里）。
 * 插话本身仍完整留在会话数据里（模型看得到、审计追得到），只是不进消息区。
 */
export function visibleMessages(msgs) {
  return (Array.isArray(msgs) ? msgs : []).filter((m) => m && !(m.role === 'user' && m.steer));
}
