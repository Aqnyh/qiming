/**
 * ui/state/store.js —— 界面状态的容器（最小订阅模型，React 用 useSyncExternalStore 订阅）。
 *
 * 为什么不引状态库：这份状态只有一个来源（本文件的 `state`）、只有一种变更方式（patch），
 * 订阅者只有 React 一层。引 Redux/Zustand 只多一层概念，不会少一行代码。
 *
 * 约定：
 *  · 任何改动都走 patch()；组件**不直接改 state**，一律调 ui/state/*.js 里的动作函数；
 *  · patch() 是"合并式"的：只覆盖传入的键；
 *  · 快照（snapshot）与可写状态（state）分开 —— useSyncExternalStore 只在快照引用变化时重渲，
 *    直接返回 state 会把更新全部吞掉（旧项目踩过的坑）。
 */
import { useSyncExternalStore } from 'react';

export const state = {
  phase: 'boot', // boot（初始化中）| login | app
  auth: null, // GET /api/auth 的状态（user / authDisabled / authenticated）
  bootError: '', // 初始化失败的说明（登录页兜底显示）
  sse: 'off', // off | open | error —— 事件流连接状态（顶栏小圆点）

  settings: null, // GET /api/settings（已脱敏：只有 keyHint/hasKey）
  projects: [], // GET /api/projects
  projectsWorkspace: '', // 工作区根目录（所有项目必须在它之下）
  currentProjectId: '', // 新建会话归属的项目（'' = 不归属）

  sessions: [], // 会话摘要列表（GET /api/sessions）
  runs: {}, // sessionId -> { runId, startedAt }：正在跑的会话（列表打点 + 输入区切换）
  activeId: null, // 当前会话 id（null = 新会话）
  msgs: [], // 当前会话的消息（服务端形状 + 本地标记）
  msgsFor: null, // msgs 属于哪个会话（加载中用 null 防止串台）
  sessionMeta: null, // 当前会话的元信息（title/projectId/model）
  activeRun: null, // 当前会话的运行状态（GET /api/session/:id 的 run）

  /** sessionId -> 排队中的消息 [{id,text,ts,mode}]：显示在输入框上方，**不进消息区**（没执行就不显示） */
  queue: {},
  /**
   * sessionId -> 上下文占用快照（服务端真分词算的分解：system/messages/tools/reserve/percent…）。
   * 顶栏的上下文环读它；刷新后由 GET /api/session/:id 的 usage 补上（不然环会一直等下一次事件）。
   */
  usage: {},
  streams: {}, // sessionId -> 流式缓冲 { runId, msgId, content, thinkingChars, thinkingTail, calls, notices, stats, steers, ended }
  todo: null, // 右上角任务清单（GET /api/todo）
  todoOpen: true,

  drawer: { open: false, section: 'plugins' }, // 设置抽屉
  downloads: false, // 「待下载」对话框
  sidebarOpen: false, // 窄屏侧栏抽屉
  toast: null, // 一条全局提示（错误/成功）
  staleServer: null,
  downloadsDir: '', // 待下载目录（服务端给）：文件卡只渲染这个目录里的文件 // { app, server } —— 前端构建指纹 ≠ 服务端进程指纹时给出"该重启了"的提示
  revision: 0, // 粗粒度版本号（依赖服务端数据的板块保存后自增，触发重渲）
};

let snapshot = { ...state };
const listeners = new Set();
let pending = false;

/** 合并式更新：只覆盖传进来的键 */
export function patch(partial) {
  Object.assign(state, partial);
  schedule();
}

/** 触发重渲（数据没放进 state、只是引用内部变了时用） */
export function touch() {
  state.revision++;
  schedule();
}

function schedule() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    snapshot = { ...state }; // 新引用 = React 认得出"变了"
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* 单个订阅者出错不影响其它 */
      }
    }
  });
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const useApp = () => useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

/* ────────────────────────── 全局提示 ────────────────────────── */

let toastSeq = 0;
let toastTimer = null;

/** 一条提示，几秒后自动消失；错误多留一会儿（用户要看完） */
export function toast(text, kind = 'info') {
  const msg = String(text ?? '').trim();
  if (!msg) return;
  patch({ toast: { id: ++toastSeq, text: msg.slice(0, 600), kind } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => patch({ toast: null }), kind === 'error' ? 8000 : 4000);
}

export function hideToast() {
  clearTimeout(toastTimer);
  patch({ toast: null });
}

/** 删除类操作统一走它：确认框是浏览器原生的，不额外做一套对话框 */
export function askConfirm(text) {
  return window.confirm(text);
}
