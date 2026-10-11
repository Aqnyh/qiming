/**
 * ui/features/CompactPanel.jsx —— 右列的「上下文压缩」小面板。
 *
 * 压缩 = 用一段交接摘要**替换**掉某段历史（见 src/agent/context.ts 的替换节点）。
 * 这个面板让这件事**可见、可撤回**：
 *   · 列出每个压缩节点：它遮蔽了哪几条消息（[from,to)）、摘要多少字、什么时候压的；
 *   · 点「撤回」删掉该节点 —— 那段原历史立刻回到请求视图（原文一直在会话文件里，没丢）。
 *
 * 没有节点时不渲染（大多数会话压根不会触发压缩，占版面反而干扰）。
 */
import { useState } from 'react';
import { useApp } from '../state/store.js';
import { removeCompactNode } from '../state/session.js';
import { Btn, Icon } from './ui.jsx';
import { fmtCount, fmtWhen } from '../lib/format.js';

export default function CompactPanel() {
  const st = useApp();
  const nodes = (st.activeId && st.compact[st.activeId]) || [];
  const [open, setOpen] = useState(false);
  if (!nodes.length) return null;

  return (
    <div className="mt-2 shrink-0 rounded-xl border border-line/70 bg-panel/40" aria-label="上下文压缩">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起' : '看被压缩（摘要替换）掉的历史'}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-raise/50"
      >
        <Icon name="chevron" className={`size-3 shrink-0 text-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon name="archive" className="size-3.5 shrink-0 text-accent" />
        <span className="text-xs text-fg">上下文压缩 · {nodes.length}</span>
        <span className="flex-1" />
        <span className="text-[10.5px] text-subtle">可撤回</span>
      </button>
      {open ? (
        <div className="thin-scroll max-h-64 overflow-y-auto border-t border-line/60 p-2">
          {nodes.map((n) => {
            const span = Math.max(0, (n.to ?? 0) - (n.from ?? 0));
            return (
              <div key={n.id} className="mb-1.5 rounded-lg border border-line/60 bg-bg/50 p-2 last:mb-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10.5px] text-muted">#{n.id}</span>
                  <span className="text-[10.5px] tabular-nums text-subtle" title={`消息下标 [${n.from}, ${n.to})`}>
                    遮蔽 {span} 条（第 {n.from}–{n.to} 条）
                  </span>
                  <span className="flex-1" />
                  <span className="text-[10.5px] tabular-nums text-subtle">{fmtCount((n.text ?? '').length)} 字</span>
                </div>
                <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted">{n.text}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="text-[10px] text-subtle">{fmtWhen(n.ts)}</span>
                  <span className="flex-1" />
                  <Btn size="sm" variant="ghost" onClick={() => void removeCompactNode(n.id)} title="撤回：这段原历史重新进入请求视图">
                    撤回
                  </Btn>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
