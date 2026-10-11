/**
 * ui/features/ChangesPanel.jsx —— 「文件改动」：右列入口条 + 右侧**大抽屉**（两个导出）。
 *
 * 为什么改抽屉：右列只有 256px 宽，diff 挤在里面只能看个大概（行号、并排视图都放不下）。
 * 现在右列只留一条"有几处改动"的入口，点开是占大半屏的抽屉 —— 参照 VS Code / GitHub
 * 的 Source Control 面板：左边选检查点、右边看 diff（见 DiffView.jsx）。
 *
 * 两个导出分工（抽屉必须挂在最外层，不能留在右列里）：
 *   · 默认导出 `ChangesPanel` —— 右列的入口条（窄屏右列是 `hidden` 的，入口跟着藏起来没问题）；
 *   · 具名导出 `ChangesDrawer` —— 由 main.jsx 挂到应用顶层（`fixed` 定位，窄屏也能盖满）。
 *
 * 数据与 `changes_*` 工具是同一份（影子 git 检查点，见 src/store/checkpoints.ts）。
 * 撤回是**破坏性**操作，仍然走 session.js 的 restoreCheckpoint（带二次确认）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../state/store.js';
import { api } from '../state/api.js';
import { closeChanges, openChanges, refreshChanges, restoreCheckpoint } from '../state/session.js';
import { Badge, Btn, Icon, Spinner } from './ui.jsx';
import DiffView from './DiffView.jsx';
import { fmtWhen } from '../lib/format.js';

/** 右侧大抽屉的骨架（与设置抽屉同一套视觉，但更宽 —— diff 要横向空间） */
function Drawer({ title, subtitle, onClose, actions, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="ml-auto flex h-full w-full max-w-[min(1200px,94vw)] flex-col border-l border-line bg-bg shadow-2xl" role="dialog" aria-label="文件改动">
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2">
          <Icon name="diff" className="size-4 shrink-0 text-accent" />
          <span className="text-sm font-medium">{title}</span>
          {subtitle ? <span className="text-[11px] text-subtle">{subtitle}</span> : null}
          <span className="flex-1" />
          {actions}
          <Btn variant="ghost" size="icon" className="size-7" onClick={onClose} title="关闭（Esc）">
            <Icon name="close" className="size-4" />
          </Btn>
        </header>
        <div className="flex min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

/** 右列那条入口（很窄，只说"有几处改动"） */
export default function ChangesPanel() {
  const st = useApp();
  const sessionId = st.activeId;
  const list = (sessionId && st.changes[sessionId]) || [];
  if (!sessionId) return null;

  return (
    <button
      type="button"
      aria-label="文件改动"
      onClick={() => openChanges()}
      className="mt-2 flex shrink-0 items-center gap-1.5 rounded-xl border border-line bg-card/95 px-2 py-1.5 text-left transition-colors hover:border-accent/40 hover:bg-card"
      title="查看文件改动（点击打开大面板）"
    >
      <Icon name="diff" className="size-3.5 shrink-0 text-accent" />
      <span className="text-xs font-medium">文件改动</span>
      {list.length ? <Badge tone="accent">{list.length}</Badge> : <span className="text-[10.5px] text-subtle">暂无</span>}
      <span className="flex-1" />
      <Icon name="chevron" className="size-3 shrink-0 text-subtle" />
    </button>
  );
}

/** 大抽屉本体（挂在应用顶层，见 main.jsx） */
export function ChangesDrawer() {
  const st = useApp();
  const sessionId = st.activeId;
  const list = (sessionId && st.changes[sessionId]) || [];
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(null); // 当前选中的检查点 id
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(
    async (cpId) => {
      if (!sessionId || !cpId) return;
      setLoading(true);
      setErr('');
      try {
        setDetail(await api(`/api/changes/diff?sessionId=${encodeURIComponent(sessionId)}&checkpoint=${encodeURIComponent(cpId)}`));
      } catch (e) {
        setErr(e?.message ?? String(e));
        setDetail(null);
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  // 打开抽屉：默认选中最新一条（除非当前选中的还在）
  useEffect(() => {
    const first = list[0]?.id ?? null;
    setPicked((cur) => (cur && list.some((c) => c.id === cur) ? cur : first));
  }, [list]);

  // 选中的检查点变了 / 清单刷新了 → 重取 diff
  useEffect(() => {
    if (!picked) return;
    void load(picked);
  }, [picked, load, list.length]);

  if (!sessionId) return null;
  const cur = list.find((c) => c.id === picked) ?? null;

  return (
    <Drawer
      title="文件改动"
      subtitle={`${list.length} 条检查点${cur ? ` · ${fmtWhen(cur.ts)}` : ''}`}
      onClose={() => closeChanges()}
      actions={
        <>
          {cur ? (
            <Btn
              size="sm"
              variant="danger"
              onClick={async () => {
                const ok = await restoreCheckpoint(cur.id, sessionId);
                if (ok) setDetail(null);
              }}
              title="撤回到这一步之前的样子（会二次确认）"
            >
              <Icon name="undo" className="size-3" />
              撤回这一步
            </Btn>
          ) : null}
          <Btn
            size="sm"
            onClick={() => {
              setBusy(true);
              void refreshChanges(sessionId).finally(() => setBusy(false));
            }}
            title="刷新清单"
          >
            {busy ? <Spinner className="size-3" /> : <Icon name="refresh" className="size-3" />}
            刷新
          </Btn>
        </>
      }
    >
      {/* 左：检查点清单 */}
      <div className="thin-scroll w-72 shrink-0 overflow-y-auto border-r border-line bg-panel/40">
        {list.length ? (
          <ul>
            {list.map((cp) => (
              <li key={cp.id}>
                <button
                  type="button"
                  onClick={() => setPicked(cp.id)}
                  className={`flex w-full flex-col gap-1 border-b border-line/50 px-2.5 py-2 text-left transition-colors ${cp.id === picked ? 'bg-raise' : 'hover:bg-raise/50'}`}
                >
                  <span className="truncate font-mono text-[11px] text-fg" title={cp.label}>
                    {cp.label}
                  </span>
                  <span className="flex items-center gap-2 text-[10px] tabular-nums text-subtle">
                    <span>{fmtWhen(cp.ts)}</span>
                    {cp.added !== undefined ? (
                      <span>
                        <span className="text-ok">+{cp.added}</span> <span className="text-danger">−{cp.removed ?? 0}</span>
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2.5 py-3 text-[11px] leading-relaxed text-subtle">
            这个会话还没改过文件。
            <br />
            改文件前会自动记一个检查点，之后就能在这里看 diff、点「撤回」退回去。
          </p>
        )}
      </div>

      {/* 右：diff 主体 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
        {cur ? (
          <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-muted">{cur.id}</span>
            {cur.files?.length ? (
              <span className="truncate text-[10.5px] text-subtle" title={cur.files.join('\n')}>
                {cur.files.length} 个路径
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {cur ? (
            <DiffView detail={detail} loading={loading} error={err} empty="这条检查点之后没有文件差异（可能是“撤回前备份”这类系统快照）。" />
          ) : (
            <p className="text-xs text-subtle">左边选一条检查点，这里显示它的 diff。</p>
          )}
        </div>
      </div>
    </Drawer>
  );
}
