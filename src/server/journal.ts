/**
 * src/server/journal.ts —— 运行日志与事件。
 *
 * 两条互补的通道（需求 7 的关键设计）：
 *  · **事件流（SSE）**：只发摘要增量 —— 正文、思考预览、调用摘要与计数。
 *    客户端不持有思考全文与工具原文，事件再密集也不会把浏览器内存撑爆。
 *  · **运行日志（磁盘）**：思考全文、每次调用的完整参数与完整结果，
 *    写到 data/runs/<runId>/。用户点开某条时再按 (runId, seq) 取回。
 *
 * 事件同时留在内存里用于"刷新后回放"（限量，超出丢最老的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runDir } from '../util/paths.ts';
import type { CallRecord, Message } from '../store/sessions.ts';
import type { Breakdown } from '../agent/context.ts';

/** 事件里的占用快照（= agent/count.ts 的 Breakdown，别名让它跨模块可读） */
export type UsageSnapshot = Breakdown;

export type RunEvent =
  | {
      type: 'run_started';
      runId: string;
      sessionId: string;
      msgId: string;
      ts: number;
      title?: string;
      /** 子智能体运行才有：父运行 id */
      parentRunId?: string;
      task?: string;
    }
  | { type: 'thinking'; runId: string; sessionId: string; msgId: string; text: string }
  | { type: 'content'; runId: string; sessionId: string; msgId: string; text: string }
  | { type: 'call'; runId: string; sessionId: string; msgId: string; call: CallRecord }
  | { type: 'call_done'; runId: string; sessionId: string; msgId: string; call: CallRecord }
  | { type: 'notice'; runId: string; sessionId: string; msgId: string; text: string }
  /** 用户插话/立即执行的状态（queued = 已收下，taken = 已注入模型） */
  | {
      type: 'steer';
      runId: string;
      sessionId: string;
      /** 排队事件发生在助手消息创建之前，所以可空 */
      msgId?: string;
      /** 排队条目的 id（界面据此把它从"排队中"里摘掉） */
      id?: string;
      text: string;
      mode: 'steer' | 'urgent';
      state: 'queued' | 'taken';
      /** 取走执行时：插话落在助手正文的第几个字符（前端据此插回原位） */
      steerAt?: number;
    }
  | { type: 'round'; runId: string; sessionId: string; msgId: string; round: number; stats: { in: number; out: number; ms: number } }
  /**
   * 文件改动的检查点（写文件前打的"动手前"快照）。
   * 界面上的"改动清单"靠它增量刷新；`restored: true` 表示这是一次撤回的结果。
   */
  | {
      type: 'checkpoint';
      runId: string;
      sessionId: string;
      msgId: string;
      checkpoint: { id: string; label: string; files: string[]; restored?: boolean };
    }
  /**
   * 上下文占用（真分词，含分解）。
   * 每次开跑前报一次（round=0），之后每轮收尾重报 —— 界面顶栏的上下文环用它。
   * 只发摘要数字（不发明细文本），所以事件很小、可以频繁发。
   */
  | { type: 'usage'; runId: string; sessionId: string; msgId: string; round: number; usage: UsageSnapshot }
  | { type: 'msg'; runId: string; sessionId: string; msg: Message }
  | { type: 'todo'; sessionId: string; items: unknown }
  | { type: 'run_end'; runId: string; sessionId: string; status: 'ok' | 'error' | 'stopped'; error?: string; ms?: number };

export type RunCallDetail = {
  seq: number;
  name: string;
  pluginId: string;
  args: unknown;
  ok: boolean;
  text: string;
  ms: number;
};

const MAX_KEEP = 400;
const MAX_EVENT_CHARS = 4000;

export function createJournal(runId: string) {
  const dir = runDir(runId);
  fs.mkdirSync(path.join(dir, 'calls'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'thinking'), { recursive: true });
  const stream = fs.createWriteStream(path.join(dir, 'events.jsonl'), { flags: 'a' });

  function clip(ev: RunEvent): RunEvent {
    if ((ev.type === 'content' || ev.type === 'thinking') && ev.text.length > MAX_EVENT_CHARS) {
      return { ...ev, text: ev.text.slice(-MAX_EVENT_CHARS) };
    }
    return ev;
  }

  function append(ev: RunEvent): void {
    try {
      stream.write(`${JSON.stringify(clip(ev))}\n`);
    } catch {
      /* 磁盘写失败不能拖垮运行 */
    }
  }

  function saveCall(detail: RunCallDetail): void {
    try {
      fs.writeFileSync(path.join(dir, 'calls', `${detail.seq}.json`), `${JSON.stringify(detail, null, 2)}\n`, 'utf8');
    } catch {
      /* 同上 */
    }
  }

  function saveThinking(msgId: string, text: string, sig: string): void {
    try {
      fs.writeFileSync(path.join(dir, 'thinking', `${msgId}.md`), text, 'utf8');
      if (sig) fs.writeFileSync(path.join(dir, 'thinking', `${msgId}.sig`), sig, 'utf8');
    } catch {
      /* 同上 */
    }
  }

  function close(): void {
    try {
      stream.end();
    } catch {
      /* ignore */
    }
  }

  return { append, saveCall, saveThinking, close, dir };
}

export type Journal = ReturnType<typeof createJournal>;

/** 按 (runId, seq) 取回一次调用的完整参数与结果 */
export function readCallDetail(runId: string, seq: number): RunCallDetail | null {
  const file = path.join(runDir(runId), 'calls', `${seq}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunCallDetail;
  } catch {
    return null;
  }
}

/** 取回某条消息的思考全文 */
export function readThinking(runId: string, msgId: string): string {
  try {
    return fs.readFileSync(path.join(runDir(runId), 'thinking', `${msgId}.md`), 'utf8');
  } catch {
    return '';
  }
}
