/**
 * src/agent/spill.ts —— 超长工具结果的落盘（spill）。
 *
 * 借鉴主流 harness（dsh 的 spill 子系统 / Claude Code 的大输出落盘）：
 * 工具结果动辄几万字符（读大文件、长命令输出、抓网页正文），**全文回灌进历史**会
 * 迅速吃掉上下文窗口，导致后面几轮"莫名被截断/被上游拒"。做法是：
 *   超过阈值就把**全文落盘**，只把「头尾预览 + 一个可直接 read_file 的路径」回灌给模型；
 *   模型需要细节时再用 read_file 精确取那一段。这样上下文占用可控，细节也没丢。
 *
 * 三条纪律：
 *  1. **阈值不设服务端硬上限**：用户填多少就是多少，填 0 = 关（全部内联）。
 *  2. **预览头尾都留**：只看开头会漏掉结尾的结论/报错，只看结尾会漏掉命令本身 —— 头尾各留一段。
 *  3. **落盘失败不改变行为**：写不进去（磁盘满/权限）就照旧内联全文，绝不因为"想省上下文"
 *     把结果弄丢。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSpillDir } from '../util/paths.ts';

export type SpillConfig = {
  /** 关掉就永远内联（用户参数 spillEnabled=false 或 spillMaxChars<=0） */
  enabled: boolean;
  /** 内联上限（字符）：结果超过它才落盘 */
  maxChars: number;
  /** 预览保留的开头字符数 */
  headChars: number;
  /** 预览保留的结尾字符数 */
  tailChars: number;
};

export const DEFAULT_SPILL: Required<SpillConfig> = {
  enabled: true,
  maxChars: 24_000,
  headChars: 4_000,
  tailChars: 4_000,
};

export type SpillResult = {
  /** 真正回灌给模型的文本（未落盘时就是原文） */
  text: string;
  /** 落盘了才有：完整正文的绝对路径（给模型 read_file 用） */
  path?: string;
  /** 落盘了才有：原始字符数 */
  chars?: number;
};

/** 把用户参数归一成一份配置（缺项用默认值） */
export function spillConfigFrom(params: {
  spillEnabled?: unknown;
  spillMaxChars?: unknown;
  spillHeadChars?: unknown;
  spillTailChars?: unknown;
}): SpillConfig {
  const num = (v: unknown, def: number): number => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  const enabled = params.spillEnabled !== false;
  const maxChars = params.spillMaxChars === undefined ? DEFAULT_SPILL.maxChars : num(params.spillMaxChars, DEFAULT_SPILL.maxChars);
  return {
    enabled: enabled && maxChars > 0,
    maxChars,
    headChars: params.spillHeadChars === undefined ? DEFAULT_SPILL.headChars : num(params.spillHeadChars, DEFAULT_SPILL.headChars),
    tailChars: params.spillTailChars === undefined ? DEFAULT_SPILL.tailChars : num(params.spillTailChars, DEFAULT_SPILL.tailChars),
  };
}

/**
 * 判断要不要落盘；要就写盘并返回预览 + 路径。
 *
 * @param cfg      用户配置（见 spillConfigFrom）
 * @param runId    运行 id（决定落盘目录）
 * @param seq      这次调用的序号（决定落盘文件名，同一次运行内唯一）
 * @param name     工具名（文件名可读）
 * @param text     工具回灌的完整文本
 */
export function maybeSpill(
  cfg: SpillConfig,
  meta: { runId: string; seq: number; name: string },
  text: string,
): SpillResult {
  if (!cfg.enabled) return { text };
  if (text.length <= cfg.maxChars) return { text };

  const safeName = meta.name.replace(/[^\w.-]/g, '_').slice(0, 40) || 'tool';
  const file = path.join(runSpillDir(meta.runId), `${meta.seq}-${safeName}.txt`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch {
    // 写不进去就照旧内联全文：宁可贵，也别把结果弄丢
    return { text };
  }

  const head = text.slice(0, cfg.headChars);
  const tail = text.slice(Math.max(cfg.headChars, text.length - cfg.tailChars));
  const omitted = text.length - head.length - tail.length;
  const preview = [
    `（结果过长已落盘：共 ${text.length} 字符，此处省略中间 ${omitted} 字符。完整内容在这个文件里，需要细节就用 read_file 读它：${file}）`,
    '',
    '—— 开头 ——',
    head,
    '',
    `……（省略 ${omitted} 字符）……`,
    '',
    '—— 结尾 ——',
    tail,
  ].join('\n');
  return { text: preview, path: file, chars: text.length };
}
