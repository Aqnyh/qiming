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

export type CompactState = { upTo: number; count: number; text: string; ts: number } | null;

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
 * 请求视图：压缩段（若有）替换掉前 upTo 条消息。
 * 摘要作为一条 user 消息注入，而不是 system —— 系统提示词要留给"当前事实"，
 * 摘要属于历史，混进 system 会让模型把过期信息当当前状态（旧项目的教训）。
 */
export function viewMessages(input: ViewInput): ChatMessage[] {
  const { messages, compact } = input;
  if (!compact || compact.upTo <= 0) return messages;
  const tail = messages.slice(Math.min(compact.upTo, messages.length));
  return [
    { role: 'user', content: `${input.compactHeader}\n\n${compact.text}` },
    { role: 'assistant', content: '（已了解此前进展，继续。）' },
    ...tail,
  ];
}

/** 压缩的切点：保留最近 keepTail 条，其余交给总结；返回 null 表示没什么可压的 */
export function compactRange(messages: ChatMessage[], keepTail = 6): { upTo: number } | null {
  if (messages.length <= keepTail + 4) return null;
  let upTo = messages.length - keepTail;
  // 切点不能落在 assistant(tool_calls) 与它的 tool 结果之间（配对会被拆散）
  while (upTo > 0) {
    const m = messages[upTo];
    if (m && m.role === 'tool') upTo -= 1;
    else break;
  }
  if (upTo <= 2) return null;
  return { upTo };
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
