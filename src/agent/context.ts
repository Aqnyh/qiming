/**
 * src/agent/context.ts —— 上下文占用统计与压缩（compaction）。
 *
 * 两件事：
 *  1. **统计**：给"还剩多少上下文"一个**真分词**的数字（见 agent/count.ts），
 *     并拆出"系统提示词 / 消息 / 工具表 / 预留输出"四项，界面直接显示这份分解；
 *  2. **压缩**：超阈值时把老消息交给模型总结成一段交接摘要，之后请求视图用摘要替换老消息。
 *
 * 为什么压缩必须发生在服务端、且以"交接摘要"的形式：会话可以跑几十轮，
 * 不压缩迟早撞上限；压缩不是"删历史"（历史仍完整留在会话文件里，界面上还能翻），
 * 只是"这次请求带什么进去"。
 *
 * 为什么统计要单独成一层（count.ts）：压缩阈值、界面百分比、UI 的颜色分级
 * 必须**用同一个数** —— 三处各算一次就会出现"环显示 80% 却还没压缩"这种自相矛盾。
 */
import type { ChatMessage, ProviderConfig, StreamEvent, ToolDef } from '../providers/types.ts';
import { breakdown, encoderFor, messageTokens, roughTokens, type Breakdown } from './count.ts';

export type { Breakdown } from './count.ts';
export { breakdown } from './count.ts';

/** 粗估（保留给测试与兜底用）：中文 1 字≈1 token，英文 4 字符≈1 token，混合取 2.6 字符/token */
export function estimateTokens(text: string): number {
  return roughTokens(text);
}

/** 一批消息的 token（真分词；model 缺省用通用词表） */
export function estimateMessages(messages: ChatMessage[], model = ''): number {
  const { count } = encoderFor(model);
  let total = 0;
  for (const m of messages) total += messageTokens(m, count);
  return total;
}

export type CompactNode = {
  /** 节点 id（界面/审计引用它，撤回时也用它） */
  id: string;
  /** 遮蔽的消息区间 [from, to)（相对**完整历史**的下标） */
  from: number;
  to: number;
  /** 该区间的交接摘要（替换掉原文） */
  text: string;
  ts: number;
};

/**
 * 压缩状态 = 一串**替换节点**（而不是"掐掉前 N 条"）。
 *
 * 借鉴 dsh 的 compaction：每次压缩声明式地记下「被哪段区间替换成了什么」，
 * 带来三个好处：
 *  1. **可审计**：原文仍在会话文件里，节点只说明"这次请求用摘要替掉了 [from,to)"；
 *  2. **可叠加**：多次压缩各自是一个节点，互不覆盖（旧模型只有一个 upTo，多次压缩会互相吞）；
 *  3. **可撤回**：删掉某个节点，那段历史立刻回到请求视图里。
 */
export type CompactState = { nodes: CompactNode[] } | null;

/** 兼容旧的单节点形态 `{ upTo, count, text, ts }`（读旧会话时归一化） */
export function normalizeCompact(raw: unknown): CompactState {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.nodes)) {
    const nodes = obj.nodes
      .filter((n): n is CompactNode => Boolean(n) && typeof n === 'object' && Number.isFinite((n as CompactNode).from))
      .map((n) => ({ ...n }));
    return nodes.length ? { nodes } : null;
  }
  // 旧形态：upTo = 前 upTo 条被一段摘要取代
  const upTo = Math.trunc(Number(obj.upTo ?? 0));
  if (upTo > 0 && typeof obj.text === 'string') {
    return { nodes: [{ id: 'legacy', from: 0, to: upTo, text: obj.text, ts: Number(obj.ts) || 0 }] };
  }
  return null;
}

/** 是否要压缩：占用（消息 + 系统 + 工具表 + 预留输出）超过上限的 75% */
export const COMPACT_RATIO = 0.75;

export type ViewInput = {
  /** 完整历史（请求形态） */
  messages: ChatMessage[];
  compact: CompactState;
  /** 系统提示词 + 工具表 + 预留的输出空间，用来算阈值 */
  overheadTokens: number;
  ctxLimit: number;
  compactHeader: string;
  /** 用来选分词编码的模型名 */
  model?: string;
};

export function needsCompaction(input: ViewInput): boolean {
  if (!input.ctxLimit || input.ctxLimit <= 0) return false;
  const used = estimateMessages(input.messages, input.model) + input.overheadTokens;
  return used > input.ctxLimit * COMPACT_RATIO;
}

/**
 * 请求视图的占用分解（界面顶栏的上下文环用它）。
 * 与 needsCompaction 共用同一套口径，避免"环上 82% 但不压缩"的自相矛盾。
 */
export function usageOf(input: {
  messages: ChatMessage[];
  system: string;
  tools: ToolDef[];
  ctxLimit: number;
  reserve: number;
  model: string;
}): Breakdown {
  return breakdown({
    messages: input.messages,
    system: input.system,
    tools: input.tools,
    limit: input.ctxLimit,
    reserve: input.reserve,
    model: input.model,
  });
}

/**
 * 请求视图：把被节点遮蔽的区间替换成各自的交接摘要（节点之外的原消息保留）。
 *
 * 摘要作为 user 消息注入，而不是 system —— 系统提示词要留给"当前事实"，
 * 摘要属于历史，混进 system 会让模型把过期信息当当前状态（旧项目的教训）。
 * 多个节点按 from 顺序拼，**只对未被更早节点覆盖的区段插入摘要**（防重叠）。
 */
export function viewMessages(input: ViewInput): ChatMessage[] {
  const { messages, compact } = input;
  const nodes = (compact?.nodes ?? []).slice().sort((a, b) => a.from - b.from);
  if (!nodes.length) return messages;
  const out: ChatMessage[] = [];
  let cursor = 0;
  for (const node of nodes) {
    const from = Math.max(0, Math.min(node.from, messages.length));
    const to = Math.max(from, Math.min(node.to, messages.length));
    if (to <= cursor) continue; // 已被更早的节点覆盖
    for (let i = cursor; i < from; i++) out.push(messages[i]!);
    out.push({ role: 'user', content: `${input.compactHeader}\n\n${node.text}` });
    out.push({ role: 'assistant', content: '（已了解此前进展，继续。）' });
    cursor = to;
  }
  for (let i = cursor; i < messages.length; i++) out.push(messages[i]!);
  return out;
}

/**
 * 待压缩的**下一个节点**：保留最近 keepTail 条，其余交给总结。
 * 已有节点的遮蔽范围内不再重复压（从最后一个节点的 to 开始算）。
 * 返回 null 表示没什么可压的。
 */
export function compactRange(messages: ChatMessage[], keepTail = 6, existing: CompactState = null): { from: number; to: number } | null {
  const nodes = existing?.nodes ?? [];
  const covered = nodes.reduce((n, node) => Math.max(n, node.to), 0);
  const start = Math.max(0, Math.min(covered, messages.length));
  const rest = messages.length - start;
  if (rest <= keepTail + 4) return null;
  let to = messages.length - keepTail;
  // 切点不能落在 assistant(tool_calls) 与它的 tool 结果之间（配对会被拆散）
  while (to > start) {
    const m = messages[to];
    if (m && m.role === 'tool') to -= 1;
    else break;
  }
  if (to <= start + 2) return null;
  return { from: start, to };
}

export type CompleteFn = (
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal },
) => Promise<string>;

/** 用模型把一段历史压成交接摘要（失败就返回 null，调用方照旧发原消息） */
export async function summarize(
  messages: ChatMessage[],
  promptText: string,
  complete: CompleteFn,
  cfg: ProviderConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  const dump = renderForSummary(messages);
  const res = await complete(cfg, [
    { role: 'system', content: promptText },
    { role: 'user', content: dump },
  ], { signal });
  const text = res.trim();
  return text ? text : null;
}

/** 把消息渲染成"给人看的记录"（保留工具调用与结果摘要，丢掉庞大原文） */
export function renderForSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(`【用户】${m.content}`);
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`【助手】${m.content}`);
      for (const c of m.toolCalls ?? []) lines.push(`【工具调用】${c.name}(${JSON.stringify(c.args ?? {}).slice(0, 400)})`);
    } else if (m.role === 'tool') {
      const body = (m.content ?? '').replace(/\s+/g, ' ').slice(0, 600);
      lines.push(`【工具结果】${body}${(m.content ?? '').length > 600 ? '…（截断）' : ''}`);
    }
  }
  return lines.join('\n').slice(0, 120_000);
}

/** 消费一次流式调用，只取文本（用于"总结"这类非工具调用） */
export async function collectText(
  stream: AsyncGenerator<StreamEvent>,
): Promise<string> {
  let out = '';
  for await (const ev of stream) {
    if (ev.kind === 'content') out += ev.text;
    else if (ev.kind === 'error') throw new Error(ev.message);
  }
  return out;
}
