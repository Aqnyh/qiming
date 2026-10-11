/**
 * src/agent/rounds.ts —— 轮次上限的**唯一判定处**（主运行 + 子智能体）。
 *
 * 为什么要单独一个文件：这两个数字以前散在 server/runner.ts 与 server/runs.ts 里，
 * 各自 `Math.min(…, 200)` 之类的临时封顶，改一处漏一处，界面上说的和实际跑的经常对不上。
 * 现在规则只写在这里，纯函数、无依赖，单测直接调。
 *
 * 规则（用户 2026-10-10 明确要求）：
 *  · **不设硬上限**：用户填多少就多少。真跑飞了用界面上的「停止」中断 ——
 *    这比"静默封在 200 轮、界面上还显示 300"诚实得多。
 *  · 0 / 空 / 负数 / 非数字 = 没设 → 回落默认。
 *
 * 归属（2026-10-10 第十一轮归一）：
 *  · 主运行轮次上限属于**系统参数**（`settings.system.maxRounds`，设置 → 系统）；
 *  · 子智能体轮次上限属于**插件参数**（子智能体插件的 `max_rounds`，设置 → 插件）。
 */

/** 子智能体没有其它线索时的兜底轮次（沿用旧行为） */
export const DEFAULT_SUB_ROUNDS = 12;

/** 取一个"用户真的设了"的正整数；没设就是 0 */
function positive(value: unknown): number {
  const n = Math.trunc(Number(value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 主运行的轮次上限。
 *
 * @param configured   系统参数里的 maxRounds（0 = 自动）
 * @param budgetRounds 各启用插件 max_calls 的汇总（runner 算好传进来）
 */
export function resolveMainRounds(configured: unknown, budgetRounds: number): number {
  const c = positive(configured);
  if (c) return c;
  // 自动：够把所有插件的额度用光，再留 2 轮余量（至少 1 轮）
  return Math.max(1, Math.trunc(Number(budgetRounds) || 0) + 2);
}

/**
 * 子智能体的轮次上限，优先级从高到低：
 *   工具入参 `max_rounds`（模型自己决定这一次要跑多久）
 *   → 插件参数 `max_rounds`（子智能体插件的参数，设置 → 插件）
 *   → {@link DEFAULT_SUB_ROUNDS}
 *
 * 下限 2（沿用旧行为）：至少"调一次工具 + 汇报一次"，1 轮做不成交办的事。
 * 填 0 表示"没设"，不是"不许跑"。
 */
export function resolveSubRounds(opts: { hint?: unknown; pluginParam?: unknown }): number {
  const n = positive(opts.hint) || positive(opts.pluginParam) || DEFAULT_SUB_ROUNDS;
  return Math.max(2, n);
}
