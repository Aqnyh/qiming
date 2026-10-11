/**
 * ui/features/AuditDialog.jsx —— 会话事件日志（append-only 真源）的查看器。
 *
 * 落实"一切过程有记录、可追溯、可审查"：
 *   · 服务端把会话历史存成**只追加**的事件日志（见 src/store/session-log.ts），
 *     msgs 只是它重放出来的投影；
 *   · 这里把日志按 seq 列出来（append / insert / replace / compact_add / compact_remove），
 *     点「原始」还能看每条事件的完整载荷。
 *
 * 数据来自 GET /api/session/<id>/log（默认精简、?raw=1 要完整）。
 */
import { useEffect, useState } from 'react';
import { api } from '../state/api.js';
import { useApp, patch } from '../state/store.js';
import { Badge, Btn, Icon, Spinner } from './ui.jsx';
import { fmtWhen } from '../lib/format.js';

const TYPE_LABEL = {
  append: '追加消息',
  insert: '插入消息（插话）',
  replace: '替换消息（定稿）',
  compact_add: '压缩节点 +',
  compact_remove: '压缩节点 −',
};

export default function AuditDialog() {
  const st = useApp();
  const open = st.auditOpen;
  const sessionId = st.activeId;
  const [events, setEvents] = useState([]);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (withRaw = raw) => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const r = await api(`/api/session/${encodeURIComponent(sessionId)}/log${withRaw ? '?raw=1' : ''}`);
      setEvents(Array.isArray(r.events) ? r.events : []);
    } catch {
      setEvents([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && patch({ auditOpen: false });
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const close = () => patch({ auditOpen: false });

  return (
    <div className="fixed inset-0 z-50 flex bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="m-auto flex h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2">
          <Icon name="clipboard" className="size-4 shrink-0 text-accent" />
          <span className="text-sm font-medium">会话事件日志</span>
          <span className="text-[11px] text-subtle">只追加 · 真源（会话消息由它重放而来）</span>
          <span className="flex-1" />
          <Btn
            size="sm"
            variant={raw ? 'primary' : 'ghost'}
            onClick={() => {
              const next = !raw;
              setRaw(next);
              void load(next);
            }}
          >
            原始载荷
          </Btn>
          <Btn variant="ghost" size="icon" className="size-7" onClick={close} title="关闭（Esc）">
            <Icon name="close" className="size-4" />
          </Btn>
        </header>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-3">
          {busy ? (
            <p className="flex items-center gap-2 text-xs text-subtle">
              <Spinner className="size-3.5" />
              正在读日志…
            </p>
          ) : null}
          {!busy && !events.length ? <p className="text-xs text-subtle">这条会话还没有事件日志。</p> : null}
          {events.map((ev) => (
            <div key={ev.seq} className="mb-1.5 rounded-lg border border-line/60 bg-panel/40 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10.5px] text-subtle">#{ev.seq}</span>
                <Badge tone={ev.type === 'compact_add' || ev.type === 'insert' ? 'accent' : undefined}>{TYPE_LABEL[ev.type] ?? ev.type}</Badge>
                <span className="flex-1" />
                <span className="text-[10.5px] text-subtle">{fmtWhen(ev.ts)}</span>
              </div>
              {ev.role ? (
                <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted">
                  {ev.role === 'user' ? '用户' : ev.role === 'tool' ? '工具' : '助手'}：{ev.content || '（空）'}
                  {ev.calls ? <span className="ml-1 text-subtle">· {ev.calls} 次工具调用</span> : null}
                  {ev.thinking ? <span className="ml-1 text-subtle">· 有思考</span> : null}
                </p>
              ) : null}
              {ev.role && ev.calls && !raw ? (
                <p className="mt-0.5 text-[10.5px] text-subtle">点「原始载荷」可看完整调用与思考</p>
              ) : null}
              {ev.node ? <p className="mt-1 text-[11px] text-muted">压缩 [#{ev.node.from}–{ev.node.to})：{ev.node.text}</p> : null}
              {ev.raw !== undefined || raw ? (
                <pre className="thin-scroll mt-1 max-h-40 overflow-auto rounded border border-line/60 bg-bg/70 p-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
                  {JSON.stringify(ev, null, 2)}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
