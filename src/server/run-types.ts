import type { RunEvent } from './journal.ts';

/**
 * 运行中发消息的三种语义（对齐主流 harness：dsh 的 inbox 两级 `next-turn`/`next-step`、
 * zcode-cli 的 Enter=同轮次 steering / Tab=下一轮次队列）：
 *
 *   `queue`（**默认**）—— 什么都不插，排在这一段运行**之后**自动执行（`flushQueue` 兑现成新的一段）。
 *                       这是"运行中再发一句"最符合直觉的行为：不打断手上的事，做完再做你的。
 *                       对应 zcode 的 Tab / dsh 的 `next-turn`。
 *   `steer`（插话）   —— 不打断任何东西，但在**当前轮次内**的**安全点**（模型调用后、工具批次后，
 *                       以及每次工具调用**返回之后**）取走注入。对应 zcode 的 Enter / dsh 的 `next-step`。
 *   `urgent`（立即执行）—— 掐掉**当前正在跑的东西**（模型流或工具），已生成的内容留档，
 *                       立刻注入并转向。**唯一在当前轮次内立刻反馈的做法**。对应 zcode 的 Esc。
 *
 * 默认值由系统参数 `queueDefault` 决定（设置 → 系统），出厂 = `queue`。
 * 为什么不把 `steer` 当默认：旧版默认 steer，于是"运行中发一句"会插进当前轮次，
 * 与用户"先把手上的事做完"的预期不符（用户 2026-10-10 明确要求改）。
 */
export type SteerMode = 'steer' | 'urgent' | 'queue';

export type RunStatus = 'running' | 'ok' | 'error' | 'stopped';

export type Run = {
  id: string;
  sessionId: string;
  projectId: string | null;
  /** 子智能体运行的父运行 id（主运行没有） */
  parentRunId?: string;
  /** 交办给子智能体的任务（界面上显示用） */
  task?: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
  controller: AbortController;
  /* 排队队列不在这里 —— 它挂在**会话**上（见 runs.ts 的 queues）：
     消息先排队、用户可以逐条删除或"立即执行"，运行结束还有剩的就接着开下一段。
     挂在运行上会出现"运行结束了队列里的消息就再也执行不了"的悬挂状态。 */
  /** 当前这次模型调用的中断把手（运行宿主注入，"打断"用） */
  currentCall: AbortController | null;
  /**
   * 当前正在跑的那个工具的掐断把手（循环的 onToolStart 交上来）。
   * 与 currentCall 分开：一次 5 分钟的命令不该拦着「立即执行」。
   */
  currentTool: AbortController | null;
  /** 内存事件（回放用，限量） */
  events: RunEvent[];
  listeners: Set<(ev: RunEvent) => void>;
  /** 供 runner 回填：本次运行最终按顺序产生的事件数（调试用） */
  emitted: number;
  /** 子智能体：最多跑几轮（由父运行按参数给定） */
  maxRoundsHint?: number;
  /** 收尾时的最终正文（子智能体靠它把结论带回父运行） */
  finalText?: string;
};

export const MAX_KEEP_EVENTS = 400;

/** 全局事件（所有运行共用一个 SSE 口；带 runId/sessionId 让客户端分流） */
export type HubListener = (ev: RunEvent) => void;

/** 一条排队中的用户消息 */
export type QueueItem = {
  id: string;
  text: string;
  ts: number;
  /**
   * steer = 安全点注入当前运行（不打断）；urgent = 掐掉当前模型调用/工具后立刻注入；
   * queue = 不注入，排在这一段运行之后（flushQueue 兑现成新的一段）。
   */
  mode: SteerMode;
};
