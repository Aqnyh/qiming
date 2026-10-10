/**
 * src/agent/count.ts —— 上下文占用的**真实** token 计数。
 *
 * 为什么要从"粗估"换成真分词：早期用「字符数 / 2.6」估，对中文偏得离谱 ——
 * 实测「中文测试一段话，看看分词效果。」15 个字符，cl100k_base 是真 15 个 token，
 * 而旧公式给 6 个（少算 60%）。上下文快满的时候，模型给的是"还能用"，实际已经撞墙，
 * 于是出现"莫名被截断/被上游拒"。主流 harness（Claude Code 等）都做真分词计数，
 * 依赖现成 tokenizer（gpt-tokenizer，纯 JS，无原生依赖），不手搓 BPE。
 *
 * 三点工程取舍：
 *  1. **按模型选编码**：GPT-4o/4.1/5/o 系列用 o200k_base，其余（Claude/DeepSeek/Qwen/GLM/Gemini…）
 *     用 cl100k_base —— 没有本地词表的模型用最接近的通用词表近似，仍远好于按字数猜；
 *  2. **计价同口径**：消息不是只有 content —— 每条有 role/分隔符开销，工具调用要序列化，
 *     图片要按官方公式折算。漏算这些会系统性偏低（一次连发 5 个工具调用能差出上千 token）；
 *  3. **兜底不抛错**：分词器坏了/遇到异常输入就退回旧的粗估，绝不让"统计"把对话搞挂。
 */
import { countTokens as countO200k } from 'gpt-tokenizer/encoding/o200k_base';
import { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import type { ChatMessage, ToolDef } from '../providers/types.ts';

/** 一段消息或工具表占用的 token 数（用于"还剩多少"的展示与压缩阈值判定） */
export type Encoder = (text: string) => number;

/** 旧公式：中文 1 字≈1 token、英文 4 字符≈1 token 的混合近似。只在分词器不可用时兜底 */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 2.6);
}

/**
 * 按模型名挑编码。
 * o200k_base（GPT-4o 之后）对中日韩更省 token，用错编码会高估 30%+；
 * 非 OpenAI 模型没有公开词表，用 cl100k_base 作为通用近似（对中文比 o200k 略保守，宁可高估）。
 */
export function encoderFor(model: string): { name: 'o200k_base' | 'cl100k_base'; count: Encoder } {
  const m = String(model ?? '').toLowerCase();
  const o200k = /gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|o1|o3|o4|codex/.test(m);
  return o200k ? { name: 'o200k_base', count: countO200k } : { name: 'cl100k_base', count: countCl100k };
}

function safeCount(count: Encoder, text: string): number {
  const s = String(text ?? '');
  if (!s) return 0;
  try {
    return count(s);
  } catch {
    return roughTokens(s);
  }
}

/** 每条消息的固定开销（role、分隔符、格式标记）。OpenAI 官方口径的近似 */
const PER_MESSAGE = 4;
/** 每次工具调用（名字 + id 骨架）的固定开销 */
const PER_TOOL_CALL = 8;
/** 图片折算：低细节按 85，高细节按「(边长/512 网格) × 170 + 85」。这里统一按偏高的口径算，宁可高估 */
const IMAGE_TOKENS = 1100;

export type Breakdown = {
  /** 系统提示词 */
  system: number;
  /** 全部请求消息（含工具调用参数、工具结果、图片） */
  messages: number;
  /** 工具表（schema + 描述）—— 每轮都随请求发出去，容易被忽略的一大块 */
  tools: number;
  /** 为模型回答预留的输出空间 */
  reserve: number;
  /** 合计占用（不含 reserve 之外的地板值） */
  used: number;
  /** 上下文上限 */
  limit: number;
  /** 剩余可用（不低于 0） */
  left: number;
  /** 占用百分比（0–100，保留一位小数；limit 为 0 时返回 0） */
  percent: number;
  /** 实际用的编码名（界面上可展示，让人知道这是"真分词"而不是估的） */
  encoding: string;
};

export type CountInput = {
  /** 请求视图里的消息（不含 system，system 单独给） */
  messages: ChatMessage[];
  system: string;
  tools: ToolDef[];
  /** 上下文上限（token），0 = 不设限（此时 percent 也算 0） */
  limit: number;
  /** 预留的输出空间 */
  reserve?: number;
  model: string;
};

/**
 * 一次完整请求的占用分解。
 *
 * 与 runner 的分工：runner 只关心"够不够、要不要压缩"（needsCompaction），
 * 界面关心的是"这 60% 具体花在哪儿"（分解）—— 所以这里一次算出两边都要的数。
 */
export function breakdown(input: CountInput): Breakdown {
  const { name, count } = encoderFor(input.model);
  const reserve = Math.max(0, Math.trunc(input.reserve ?? 0));

  const system = safeCount(count, input.system);
  let messages = 0;
  for (const m of input.messages) messages += messageTokens(m, count);
  let tools = 0;
  if (input.tools.length) {
    for (const t of input.tools) {
      tools += safeCount(count, t.name) + safeCount(count, t.description) + safeCount(count, JSON.stringify(t.schema ?? {}));
    }
    tools += input.tools.length * 2;
  }

  const rawUsed = system + messages + tools;
  const used = rawUsed + reserve;
  const limit = Math.max(0, Math.trunc(input.limit ?? 0));
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;
  return {
    system,
    messages,
    tools,
    reserve,
    used,
    limit,
    left: limit > 0 ? Math.max(0, limit - used) : 0,
    percent,
    encoding: name,
  };
}

/** 单条消息的 token（含工具调用、图片、思考） */
export function messageTokens(m: ChatMessage, count: Encoder): number {
  let n = PER_MESSAGE + safeCount(count, m.content ?? '');
  for (const c of m.toolCalls ?? []) {
    n += PER_TOOL_CALL + safeCount(count, c.name) + safeCount(count, JSON.stringify(c.args ?? {}));
  }
  if (m.thinking) n += safeCount(count, m.thinking);
  if (m.images?.length) n += m.images.length * IMAGE_TOKENS;
  return n;
}
