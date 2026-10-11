/**
 * ui/features/SubagentPanel.jsx —— 右列的「子智能体」小面板。
 *
 * 让子智能体**可见、可续、可中断**（对照 dsh 的 subagent 控制面）：
 *   · 列出本次进程里开过的子体：任务、状态、跑了几段、最近结论；
 *   · 点「续谈」给某个子体再发一句话 —— 它带着自己的历史接着做（不丢上文）；
 *   · 点「中断」掐掉它当前那一段（已产出的内容留档）。
 *
 * 数据来自 GET /api/subagents（内存登记表，进程重启即散；转录仍在 runs/<runId>/）。
 * 没有子体时不渲染。
 */
import { useEffect, useState } from 'react';
import { api } from '../state/api.js';
import { toast } from '../state/store.js';
import { Badge, Btn, Icon, Spinner } from './ui.jsx';
import { fmtWhen } from '../lib/format.js';

export default function SubagentPanel() {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({}); // id -> 续谈草稿
  const [busy, setBusy] = useState('');

  const load = async () => {
    try {
      const r = await api('/api/subagents');
      setList(Array.isArray(r.subagents) ? r.subagents : []);
    } catch {
      /* 拉不到不影响聊天 */
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000); // 轻量轮询：子体状态不长驻
    return () => clearInterval(t);
  }, []);

  const send = async (id) => {
    const text = String(draft[id] ?? '').trim();
    if (!text) return;
    setBusy(id);
    try {
      await api('/api/subagents', { method: 'POST', body: { id, text } });
      setDraft((d) => ({ ...d, [id]: '' }));
      toast('已把这句话发给子智能体（它带着自己的历史继续）', 'ok');
      await load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const stop = async (id) => {
    try {
      await api('/api/subagents', { method: 'POST', body: { id, action: 'stop' } });
      await load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  if (!list.length) return null;

  return (
    <div className="mt-2 shrink-0 rounded-xl border border-line/70 bg-panel/40" aria-label="子智能体">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起' : '看子智能体（可续谈、可中断）'}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-raise/50"
      >
        <Icon name="chevron" className={`size-3 shrink-0 text-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon name="brain" className="size-3.5 shrink-0 text-accent" />
        <span className="text-xs text-fg">子智能体 · {list.length}</span>
        <span className="flex-1" />
        {list.some((s) => s.status === 'running') ? <Spinner className="size-3 text-accent" /> : null}
      </button>
      {open ? (
        <div className="thin-scroll max-h-72 overflow-y-auto border-t border-line/60 p-2">
          {list.map((s) => (
            <div key={s.id} className="mb-1.5 rounded-lg border border-line/60 bg-bg/50 p-2 last:mb-0">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10.5px] text-muted">{s.id}</span>
                <Badge tone={s.status === 'running' ? 'accent' : s.status === 'ok' ? undefined : 'warn'}>{s.status}</Badge>
                <span className="text-[10.5px] text-subtle">{s.runs} 段</span>
                <span className="flex-1" />
                <span className="text-[10px] text-subtle">{fmtWhen(s.createdAt)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted" title={s.task}>
                {s.task}
              </p>
              {s.finalText ? <p className="mt-0.5 line-clamp-2 text-[10.5px] text-subtle">结论：{s.finalText}</p> : null}
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  value={draft[s.id] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && draft[s.id]?.trim() && void send(s.id)}
                  placeholder="给这个子体再发一句…"
                  className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 text-[11px] outline-none focus:border-accent/60"
                />
                <Btn size="sm" disabled={busy === s.id || !draft[s.id]?.trim()} onClick={() => void send(s.id)}>
                  {busy === s.id ? <Spinner className="size-3" /> : '续谈'}
                </Btn>
                {s.status === 'running' ? (
                  <Btn size="sm" variant="danger" onClick={() => void stop(s.id)} title="中断它当前那一段">
                    中断
                  </Btn>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
