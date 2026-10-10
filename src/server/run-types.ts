/**
 * src/server/run-types.ts —— 运行对象的形状（注册表与宿主共用，避免模块环）。
 */
import type { RunEvent } from './journal.ts';

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
  /** 当前这次模型调用的中断把手（运行宿主注入，"立即执行"用） */
  currentCall: AbortController | null;
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
  /** steer = 到下一轮次边界就交给模型；urgent = 已点过"立即执行"（会打断当前调用） */
  mode: 'steer' | 'urgent';
};
