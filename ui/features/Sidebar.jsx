/**
 * ui/features/Sidebar.jsx —— 左侧会话列表：品牌、+（选项目新建）、按项目分组、置顶/归档。
 *
 * 交互约定（需求 4/5）：
 *  · 项目选择器**不在这里**了 —— 点「+」弹出项目清单，选中哪个就在哪个项目下建一条空会话
 *    （服务端当场落库，于是它立刻出现在对应分组里）；
 *  · 每个会话、每个项目分组后面都有「置顶」与「归档」两个按钮（悬停出现，避免列表被按钮塞满）；
 *    归档 = 从侧栏移走，进「设置 → 归档」，可恢复或彻底删除；
 *  · 列表顺序由服务端给（置顶优先，其次最近更新），前端不重排。
 *
 * 滚动：这一栏自己滚（min-h-0 + overflow-y-auto），消息区滚动不会带动它（需求 7）。
 * 窄屏（<md）时整栏变成抽屉：顶栏的汉堡键开合，选中会话后自动收起。
 *
 * 手机（<md）三处专门适配（2026-10-10）：抽屉不占满整屏（留一条能看到消息区的边，
 * 随时能点一下收回去）、顶部让开刘海（safe-area-inset-top）、行内的置顶/归档按钮
 * 常显（触屏没有 hover，见 styles.css 的 pointer:coarse 段）。
 */
import { useState } from 'react';
import { useApp } from '../state/store.js';
import {
  archiveProject,
  archiveSession,
  closeSidebar,
  newSession,
  openSession,
  pinProject,
  pinSession,
} from '../state/session.js';
import { Btn, Icon, Spinner } from './ui.jsx';
import { fmtWhen } from '../lib/format.js';

/** 会话按项目分组；未知 projectId 归到「其它」，没有项目的会话归到「未归属项目」 */
function groupSessions(sessions, projects) {
  const byId = new Map(projects.map((p) => [p.id, { id: p.id, name: p.name, pinned: Boolean(p.pinned), items: [] }]));
  const none = { id: '', name: '未归属项目', pinned: false, items: [] };
  const unknown = { id: '__unknown', name: '其它项目', pinned: false, items: [] };
  for (const s of sessions) {
    const g = !s.projectId ? none : (byId.get(s.projectId) ?? unknown);
    g.items.push(s);
  }
  const out = [...byId.values()].filter((g) => g.items.length);
  if (none.items.length) out.push(none);
  if (unknown.items.length) out.push(unknown);
  // 置顶项目在前（组内会话顺序已由服务端排好）
  return out.sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/** 行内小按钮（悬停才出现；手机上由 styles.css 的 pointer:coarse 强制常显） */
function RowBtn({ icon, title, onClick }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="row-btn hidden shrink-0 rounded p-0.5 text-subtle hover:bg-raise hover:text-fg group-hover:block"
    >
      <Icon name={icon} className="size-3" />
    </button>
  );
}

export default function Sidebar() {
  const st = useApp();
  const groups = groupSessions(st.sessions, st.projects);
  const open = st.sidebarOpen;
  const [picker, setPicker] = useState(false);

  return (
    <>
      {/* 窄屏遮罩 */}
      {open ? <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={closeSidebar} /> : null}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-line bg-panel pt-[env(safe-area-inset-top)] transition-transform md:static md:z-auto md:w-64 md:translate-x-0 md:pt-0 max-md:w-[86vw] ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* 品牌行：高度与顶栏一致（h-14），于是两边的下边框在同一条线上（需求 3） */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="grid size-7 place-items-center rounded-lg bg-accent/15 text-accent">
            <Icon name="brain" className="size-4.5" />
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-base font-semibold tracking-wide">启明</span>
            <span className="block truncate text-[10.5px] text-subtle">本机智能体</span>
          </span>
          <span className="flex-1" />
          <Btn variant="ghost" size="icon" onClick={closeSidebar} className="md:hidden max-md:h-10 max-md:w-10" title="收起" aria-label="收起会话列表">
            <Icon name="close" className="size-4" />
          </Btn>

          {/* 「+」：先选项目，再在该项目下建一条新会话（需求 4） */}
          <div className="relative">
            <Btn variant="ghost" size="icon" onClick={() => setPicker((v) => !v)} title="新建会话（先选项目）" className="max-md:h-10 max-md:w-10">
              <Icon name="plus" className="size-4" />
            </Btn>
            {picker ? (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setPicker(false)} />
                <div className="absolute top-full right-0 z-50 mt-1 w-60 rounded-xl border border-line bg-card p-1 shadow-2xl">
                  <p className="px-2 py-1 text-[10.5px] text-subtle">在哪个项目下新建会话？</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPicker(false);
                      void newSession(null);
                    }}
                    className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-raise"
                  >
                    <Icon name="file" className="size-3 shrink-0 text-subtle" />
                    不归属项目（在用户主目录下工作）
                  </button>
                  {(st.projects ?? []).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setPicker(false);
                        void newSession(p.id);
                      }}
                      className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-raise"
                    >
                      <Icon name="folder" className="size-3 shrink-0 text-subtle" />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {p.pinned ? <Icon name="pin" className="size-3 shrink-0 text-accent" /> : null}
                    </button>
                  ))}
                  {!st.projects?.length ? (
                    <p className="px-2 py-1.5 text-[10.5px] text-subtle">还没有项目 —— 到「设置 → 项目」里建一个。</p>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>

        {/* 会话列表：这一栏自己滚（需求 7） */}
        <nav data-region="sessions" className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          {!st.sessions.length ? (
            <p className="px-2 py-6 text-center text-xs leading-relaxed text-subtle">
              还没有会话。
              <br />
              点右上角的「+」选个项目，或在下面输入第一条消息。
            </p>
          ) : null}
          {groups.map((g) => (
            <div key={g.id} className="mb-2">
              <div className="group sticky top-0 z-10 flex items-center gap-1.5 bg-panel/95 px-2 pt-2 pb-1.5 text-sm font-medium text-muted backdrop-blur">
                <Icon name="folder" className="size-3.5 shrink-0 text-subtle" />
                <span className="min-w-0 flex-1 truncate" title={g.name}>
                  {g.name}
                </span>
                {g.pinned ? <Icon name="pin" className="size-3 shrink-0 text-accent" /> : null}
                <span className="shrink-0 rounded-full bg-raise px-1.5 text-[10px] leading-4 tabular-nums text-subtle">{g.items.length}</span>
                {/* 项目行也有置顶与归档（需求 5）；「未归属/其它」不是真项目，没有这两个动作 */}
                {g.id && !g.id.startsWith('__') ? (
                  <>
                    <RowBtn icon="pin" title={g.pinned ? '取消置顶项目' : '置顶项目'} onClick={() => void pinProject(g.id, !g.pinned)} />
                    <RowBtn
                      icon="archive"
                      title="归档项目（连同它的会话，可在「设置 → 归档」恢复）"
                      onClick={() => void archiveProject(g.id, true)}
                    />
                  </>
                ) : null}
              </div>
              {g.items.map((s) => {
                const active = s.id === st.activeId;
                const running = Boolean(st.runs[s.id]);
                return (
                  <div
                    key={s.id}
                    onClick={() => openSession(s.id)}
                    className={`group relative mb-0.5 cursor-pointer rounded-lg px-2 py-1.5 ${active ? 'bg-raise' : 'hover:bg-raise/60'}`}
                  >
                    <div className="flex items-center gap-1.5">
                      {running ? <Spinner className="size-3 shrink-0 text-accent" /> : null}
                      {s.pinned && !running ? <Icon name="pin" className="size-3 shrink-0 text-accent" /> : null}
                      <span className={`min-w-0 flex-1 truncate text-xs ${active ? 'text-fg' : 'text-fg/90'}`}>{s.title || '新会话'}</span>
                      <span className="row-when shrink-0 text-[10px] tabular-nums text-subtle group-hover:hidden">{fmtWhen(s.updatedAt || s.ts)}</span>
                      <RowBtn icon="pin" title={s.pinned ? '取消置顶' : '置顶'} onClick={() => void pinSession(s.id, !s.pinned)} />
                      <RowBtn icon="archive" title="归档（可在「设置 → 归档」恢复）" onClick={() => void archiveSession(s.id, true)} />
                    </div>
                    {s.last ? <div className="mt-0.5 truncate pl-0 text-[11px] text-subtle">{s.last}</div> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
