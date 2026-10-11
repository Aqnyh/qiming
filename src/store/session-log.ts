/**
 * src/store/session-log.ts —— 会话的 **append-only 事件日志**（会话历史的唯一真源）。
 *
 * 为什么改（借鉴 dsh 的 SessionEvent 设计）：
 * 此前 `sessions.json` 存的是**可变** `msgs[]` —— 于是"历史自愈""插话插入""定稿替换"
 * 全靠就地改数组，一旦某条路径写歪就再也说不清（本工程真的踩过：打断分支重复 push，
 * 拼出「两条同 id 的 assistant(tool_calls)」，上游整段请求 400，错误文案里一个字都不提原因）。
 *
 * 现在：
 *   · **真源是事件日志**（只追加、不可变、带自增 seq）：每条事件描述"发生了什么"；
 *   · `msgs` 是**派生投影**（`deriveMessages(events)`），任何时刻都能从日志重建，写歪了也能重放；
 *   · 旧存档没有 events → 读入时用 `legacyEventsFromMsgs()` 反向补一份，之后只走事件。
 *
 * 事件类型刻意只覆盖"会改变会话历史"的动作；标题/置顶/归档这类元信息仍走本身字段
 * （它们不影响模型历史，塞进日志只会让重放变复杂）。
 */
import type { Message } from './sessions.ts';

export type SessionEvent =
  /** 追加一条消息（用户提问 / 助手定稿） */
  | { seq: number; type: 'append'; ts: number; msg: Message }
  /** 在 anchorId 之前插入一条消息（运行中的插话） */
  | { seq: number; type: 'insert'; ts: number; beforeId: string; msg: Message }
  /** 用定稿替换同 id 的占位（助手消息边跑边更新，收尾时定稿） */
  | { seq: number; type: 'replace'; ts: number; msg: Message }
  /** 新增一个压缩替换节点 */
  | { seq: number; type: 'compact_add'; ts: number; node: { id: string; from: number; to: number; text: string; ts: number } }
  /** 删除一个压缩替换节点（撤回） */
  | { seq: number; type: 'compact_remove'; ts: number; nodeId: string };

/** 事件日志（不可变、只追加；seq 自增用于审计与定位） */
export type SessionLog = SessionEvent[];

/** 每条事件都带一个**深拷贝的消息快照**：日志一旦记下就不再被后续修改影响（不可变） */
function cloneMsg(m: Message): Message {
  return JSON.parse(JSON.stringify(m)) as Message;
}

/** 给事件打上自增 seq（调用方只管 append，序号由这里统一给） */
export function nextSeq(log: SessionLog): number {
  return (log.length ? log[log.length - 1]!.seq : 0) + 1;
}

/**
 * 把旧存档的 `msgs[]` 反向补成事件日志（只在"一条会话还没有日志"时做一次）。
 *
 * 顺序即真相：msgs 里每一条都补一个 `append` 事件 —— 这样从日志重放出的 msgs 与原来**逐个一致**，
 * 不会因为引入日志而改变既有会话的历史。
 */
export function legacyEventsFromMsgs(msgs: Message[]): SessionLog {
  const log: SessionLog = [];
  msgs.forEach((m, i) => {
    log.push({ seq: i + 1, type: 'append', ts: m.ts ?? Date.now(), msg: cloneMsg(m) });
  });
  return log;
}

/**
 * 从事件日志**派生**模型/界面看到的消息序列。
 *
 * 这是"真源 → 视图"的唯一函数：想弄清"会话里到底有什么消息"，只认它。
 * 三条规则：
 *  · `append` 直接追加；
 *  · `insert` 在 beforeId 之前插入（找不到锚点就追加到末尾，容错）；
 *  · `replace` 按 id 合并（助手消息定稿：正文/调用/统计/思考补全）。
 */
export function deriveMessages(log: SessionLog): Message[] {
  const out: Message[] = [];
  const index = new Map<string, number>();
  for (const ev of log) {
    if (ev.type === 'append') {
      index.set(ev.msg.id, out.length);
      out.push(cloneMsg(ev.msg));
    } else if (ev.type === 'insert') {
      const at = index.get(ev.beforeId);
      if (at === undefined) {
        index.set(ev.msg.id, out.length);
        out.push(cloneMsg(ev.msg));
      } else {
        out.splice(at, 0, cloneMsg(ev.msg));
        for (const [id, i] of index) if (i >= at) index.set(id, i + 1);
        index.set(ev.msg.id, at);
      }
    } else if (ev.type === 'replace') {
      const at = index.get(ev.msg.id);
      if (at === undefined) {
        index.set(ev.msg.id, out.length);
        out.push(cloneMsg(ev.msg));
      } else {
        // 定稿：以新快照为准（占位里的旧字段被完整覆盖）
        out[at] = cloneMsg(ev.msg);
      }
    }
    // compact_* 不影响消息序列本身（它只改"这次请求带什么"，见 agent/context.ts）
  }
  return out;
}

/** 从事件日志派生压缩节点（与 deriveMessages 同源，保证两者一致） */
export function deriveCompact(log: SessionLog): Array<{ id: string; from: number; to: number; text: string; ts: number }> {
  const nodes: Array<{ id: string; from: number; to: number; text: string; ts: number }> = [];
  for (const ev of log) {
    if (ev.type === 'compact_add') nodes.push(ev.node);
    else if (ev.type === 'compact_remove') {
      const i = nodes.findIndex((n) => n.id === ev.nodeId);
      if (i >= 0) nodes.splice(i, 1);
    }
  }
  return nodes;
}

/* ────────────────────────── 写入口（唯一允许追加事件的地方） ────────────────────────── */

export function appendMsg(log: SessionLog, msg: Message): SessionEvent {
  const ev: SessionEvent = { seq: nextSeq(log), type: 'append', ts: Date.now(), msg: cloneMsg(msg) };
  log.push(ev);
  return ev;
}

export function insertMsg(log: SessionLog, beforeId: string, msg: Message): SessionEvent {
  const ev: SessionEvent = { seq: nextSeq(log), type: 'insert', ts: Date.now(), beforeId, msg: cloneMsg(msg) };
  log.push(ev);
  return ev;
}

export function replaceMsg(log: SessionLog, msg: Message): SessionEvent {
  const ev: SessionEvent = { seq: nextSeq(log), type: 'replace', ts: Date.now(), msg: cloneMsg(msg) };
  log.push(ev);
  return ev;
}

export function addCompactNode(log: SessionLog, node: { id: string; from: number; to: number; text: string; ts: number }): SessionEvent {
  const ev: SessionEvent = { seq: nextSeq(log), type: 'compact_add', ts: Date.now(), node: { ...node } };
  log.push(ev);
  return ev;
}

export function removeCompactNodeById(log: SessionLog, nodeId: string): SessionEvent {
  const ev: SessionEvent = { seq: nextSeq(log), type: 'compact_remove', ts: Date.now(), nodeId };
  log.push(ev);
  return ev;
}
