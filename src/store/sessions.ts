/**
 * src/store/sessions.ts —— 会话持久化。
 *
 * 一份 sessions.json 装全部会话（与旧项目一致），但**写入纪律**在这里：
 *  - 运行中按节流落盘（runner 负责），收尾时必定落盘；
 *  - 消息里带 thinking 全文与调用摘要，明细（工具参数/结果全文）在 data/runs/。
 *
 * 消息结构是本文件与前端共用的契约，字段只增不改名。
 */
import { readJson, writeJson, now, newId } from './kv.ts';
import { SESSIONS_FILE } from '../util/paths.ts';
import { deriveCompact, deriveMessages, legacyEventsFromMsgs, appendMsg, insertMsg, replaceMsg, type SessionLog } from './session-log.ts';
import { normalizeCompact } from '../agent/context.ts';

export type CallRecord = {
  seq: number;
  name: string;
  label: string;
  plugin: string;
  argsDigest: string;
  state: 'running' | 'ok' | 'fail';
  /** 失败时的标准错误码（界面按它分类，见 plugins/types.ts 的 ToolErrorCode） */
  errorCode?: string;
  ms?: number;
  digest?: string;
  chars?: number;
  lines?: { added: number; removed: number };
  /**
   * 这次调用出现在正文的哪个位置（字符偏移）。前端按它把媒体/文件卡**插到模型说那句话的位置**，
   * 而不是一律堆在整段文本之后（用户报的"没有按顺序显示"）。
   * 语义：本轮正文写完时的累计长度 —— 卡片就该出现在它后面。
   */
  contentAt?: number;
  files?: string[];
  /** 给用户看的媒体（前端渲染成图片/播放器） */
  media?: Array<{ kind: 'image' | 'video' | 'audio'; url?: string; download?: string; caption?: string }>;
  /** 子智能体的转录（runId 指向子运行） */
  subRunId?: string;
  /**
   * 超大结果被落盘（spill）时的记录：完整正文在 `path`（服务端文件），
   * 回灌给模型的是头尾预览。界面据此显示"全文已落盘 · N 字符 · 路径可复制"。
   */
  spill?: { path: string; chars: number };
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  /** assistant 的思考全文（服务端存，界面展开时才取） */
  thinking?: string;
  calls?: CallRecord[];
  stats?: { in: number; out: number; ms: number };
  /** 这一段运行里最后达到的 turn / step（用户输入划 turn、模型调用划 step；见 agent/loop.ts） */
  turn?: number;
  step?: number;
  error?: string;
  /** 产出这条消息的运行 id：界面按 (runId, msgId) 从服务端取思考全文 */
  runId?: string;
  /**
   * 这一轮的用户插话（运行中补充的说明）。
   * **不再画成气泡**：它的唯一呈现是循环注入的浅文字提示（`notices`，随助手消息落盘），
   * 同一句话画两遍是用户明确不要的。记录本身仍保留（模型看得到、也便于审计）。
   */
  steer?: boolean;
  /** 插话是"排队"还是"立即执行"（界面上区分措辞用） */
  steerMode?: 'steer' | 'urgent';
  /**
   * 助手消息：本段运行期间循环注入的浅文字提示（插话、重试、截断、轮次上限…）。
   *
   * 为什么必须落盘：它此前只活在浏览器的流式缓冲里（stream.notices），
   * 刷新/换设备/运行结束后就**全没了** —— 而插话提示一旦消失，
   * 用户就再也看不到"自己插的那句话被谁接下了"（而插话本身又不画气泡）。
   */
  notices?: string[];
};

export type Session = {
  id: string;
  title: string;
  ts: number;
  updatedAt: number;
  projectId: string | null;
  providerId: string | null;
  model: string;
  /**
   * 会话消息：**派生投影**（由 `log` 重放得到，见 store/session-log.ts）。
   * 保留这个字段是为了兼容既有读写方（界面/API 一直读它）；写入一律走日志，
   * 再由 log 重建，避免"两处各写一份、写歪了说不清"（本工程真踩过）。
   */
  msgs: Message[];
  /**
   * 会话历史的**唯一真源**：append-only 事件日志（只追加、带自增 seq、不可变）。
   * 旧存档没有它 → 读入时用 legacyEventsFromMsgs(msgs) 反向补一份（见 normalizeSession）。
   */
  log?: SessionLog;
  /**
   * 压缩状态：一串**替换节点**（每个声明式地记「被哪段区间 [from,to) 替换成了什么摘要」）。
   * 原文仍完整留在 msgs 里（可审计）；改请求视图只在这一层。旧存档的单 upTo 形态读时归一化。
   */
  compact?: { nodes: Array<{ id: string; from: number; to: number; text: string; ts: number }> };
  /** 置顶（排在列表最前） */
  pinned?: boolean;
  /** 归档时间（有值 = 在归档页，不在侧栏） */
  archivedAt?: number;
};

type Store = { version: number; updatedAt: number; sessions: Session[] };

const EMPTY: Store = { version: 1, updatedAt: 0, sessions: [] };

export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 24 ? `${one.slice(0, 24)}…` : one || '新会话';
}

export function newSession(opts: { projectId?: string | null; providerId?: string | null; model?: string } = {}): Session {
  const ts = now();
  return {
    id: newId('s'),
    title: '新会话',
    ts,
    updatedAt: ts,
    projectId: opts.projectId ?? null,
    providerId: opts.providerId ?? null,
    model: opts.model ?? '',
    msgs: [],
  };
}

export function newMessage(role: 'user' | 'assistant', content: string, extra?: Partial<Message>): Message {
  return { id: newId('m'), role, content, ts: now(), ...extra };
}

export function readSessions(): Store {
  const s = readJson<Store>(SESSIONS_FILE, EMPTY);
  const sessions = Array.isArray(s.sessions) ? s.sessions : [];
  return { version: 1, updatedAt: s.updatedAt ?? 0, sessions: sessions.map(normalizeSession) };
}

/**
 * 归一化一条会话：**保证 log 存在、且 msgs 是 log 的派生物**。
 *
 * 两条：
 *  1. 旧存档没有 log → 用 legacyEventsFromMsgs(msgs) 反向补（结果与原来逐条一致，不改历史）；
 *  2. 用 log 重放出的消息序列**替换** msgs（真源是 log；msgs 只是投影，见 store/session-log.ts）。
 * 压缩节点同理，从 log 派生回 session.compact（旧存档的 compact 也补进 log）。
 */
export function normalizeSession(session: Session): Session {
  if (!session || typeof session !== 'object') return session;
  let log: SessionLog = Array.isArray(session.log) ? session.log : [];
  if (!log.length) {
    log = legacyEventsFromMsgs(session.msgs ?? []);
    // 旧存档里已有的压缩节点（单 upTo 形态或 nodes）一并补进日志，避免丢
    const nodes = normalizeCompact(session.compact)?.nodes ?? [];
    for (const n of nodes) log.push({ seq: log.length + 1, type: 'compact_add', ts: n.ts ?? Date.now(), node: { ...n } });
  }
  session.log = log;
  session.msgs = deriveMessages(log);
  const nodes = deriveCompact(log);
  session.compact = nodes.length ? { nodes } : undefined;
  return session;
}

export function writeSessions(store: Store): void {
  store.updatedAt = now();
  // 落盘前把每条会话归一到"log 为真源"的状态，写出的永远自洽
  store.sessions = (store.sessions ?? []).map(normalizeSession);
  writeJson(SESSIONS_FILE, store);
}

/** 排序：置顶优先，其次按最近更新 */
export function sortSessions(list: Session[]): Session[] {
  return list
    .slice()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
}

export function listSessions(opts: { archived?: boolean } = {}): Session[] {
  const wantArchived = opts.archived === true;
  return sortSessions(readSessions().sessions.filter((s) => Boolean(s.archivedAt) === wantArchived));
}

/** 列表用的轻量视图：不带消息体（会话多了以后整份传输很浪费） */
export function sessionSummaries(opts: { archived?: boolean } = {}) {
  return listSessions(opts).map((s) => ({
    id: s.id,
    title: s.title,
    ts: s.ts,
    updatedAt: s.updatedAt,
    projectId: s.projectId,
    model: s.model,
    count: s.msgs.length,
    last: lastLine(s),
    pinned: Boolean(s.pinned),
    archivedAt: s.archivedAt ?? null,
  }));
}

function lastLine(s: Session): string {
  const last = s.msgs[s.msgs.length - 1];
  if (!last) return '';
  const text = last.content.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function getSession(id: string): Session | null {
  return readSessions().sessions.find((s) => s.id === id) ?? null;
}

export function putSession(session: Session): Session {
  const store = readSessions();
  const i = store.sessions.findIndex((s) => s.id === session.id);
  session.updatedAt = now();
  // 落盘前归一：log 是真源，msgs 由它重放（见 normalizeSession）
  normalizeSession(session);
  if (i >= 0) store.sessions[i] = session;
  else store.sessions.push(session);
  writeSessions(store);
  return session;
}

/* ────────────────────────── 会话历史的写入口（唯一：走 append-only 日志） ────────────────────────── */
/*
 * 为什么收在这三个函数里：会话历史以前是"直接改 session.msgs 数组"，散在各处，
 * 写歪了没有任何记录可查。现在真源是 session.log（只追加、不可变），
 * msgs 每次都由 log 重放得到 —— 于是"历史自洽"是结构性保证，不靠自觉。
 */

/** 追加一条消息（用户提问 / 助手定稿） */
export function appendMessage(session: Session, msg: Message): void {
  ensureLog(session);
  appendMsg(session.log!, msg);
  session.msgs = deriveMessages(session.log!);
}

/** 在锚点消息之前插入（运行中插话；锚点不存在则追加到末尾） */
export function insertMessage(session: Session, beforeId: string, msg: Message): void {
  ensureLog(session);
  insertMsg(session.log!, beforeId, msg);
  session.msgs = deriveMessages(session.log!);
}

/** 用定稿替换同 id 的占位（助手消息收尾）；同 id 不存在则等价 append */
export function replaceMessage(session: Session, msg: Message): void {
  ensureLog(session);
  replaceMsg(session.log!, msg);
  session.msgs = deriveMessages(session.log!);
}

/** 会话若还没有日志（新建/旧档），按当前 msgs 补一份 */
function ensureLog(session: Session): void {
  if (!Array.isArray(session.log) || !session.log.length) {
    if ((session.msgs ?? []).length) {
      session.log = legacyEventsFromMsgs(session.msgs);
      const nodes = normalizeCompact(session.compact)?.nodes ?? [];
      for (const n of nodes) session.log.push({ seq: session.log.length + 1, type: 'compact_add', ts: n.ts ?? Date.now(), node: { ...n } });
    } else {
      session.log = [];
    }
  }
}

/** 置顶 / 取消置顶 */
export function pinSession(id: string, pinned: boolean): Session | null {
  const store = readSessions();
  const session = store.sessions.find((s) => s.id === id);
  if (!session) return null;
  session.pinned = pinned;
  writeSessions(store);
  return session;
}

/** 归档 / 恢复（归档不是删除：记录与消息都在，只是从侧栏移走） */
export function archiveSession(id: string, archived: boolean): Session | null {
  const store = readSessions();
  const session = store.sessions.find((s) => s.id === id);
  if (!session) return null;
  if (archived) session.archivedAt = now();
  else delete session.archivedAt;
  writeSessions(store);
  return session;
}

/** 彻底删除（只在归档页可用；不可恢复） */
export function deleteSession(id: string): boolean {
  const store = readSessions();
  const i = store.sessions.findIndex((s) => s.id === id);
  if (i < 0) return false;
  store.sessions.splice(i, 1);
  writeSessions(store);
  return true;
}

/** 会话标题：首条用户消息定音，之后不再改（除非用户手改） */
export function touchTitle(session: Session, text: string): void {
  if (session.title === '新会话' && text.trim()) session.title = titleFrom(text);
}
