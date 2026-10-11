/**
 * ui/features/Header.jsx —— 顶栏：模型连接状态 → 项目名称 → 会话名称（需求 3 的顺序）。
 *
 * 高度与左侧品牌行一致（都是 h-14），所以两边的下边框在同一条线上，不会错位。
 * 三项都是"我现在在哪儿、模型通不通"这类即时信息 —— 刷新页面、切会话、换模型后立刻反映。
 *
 * 模型状态的口径：有服务商且填了 key = 绿点；有服务商但没 key = 黄点（对话会失败，早提示）；
 * 一个服务商都没有 = 红点（引导去设置）。事件流断开时另有一行小字说明。
 *
 * **手机（<md）只留两个按键**（2026-10-10 手机适配）：左边会话抽屉、右边设置抽屉。
 * 其余一切都收起来 —— 模型状态/项目名/上下文环/实时状态这些"状态"类信息、
 * 以及日志/待办/待下载这些"面板"类入口，在 390px 宽的屏幕上不是挤成一条就是误触。
 * 手机上要用的东西各自归位：会话去左侧抽屉，设置与产物（待下载）去右侧抽屉，
 * 待办/文件改动在右列（<sm 不占位，改由「运行中」摘要与消息内的折叠组体现）。
 * 宽屏（≥md）的排布与以前完全一致。
 */
import { useApp, patch } from '../state/store.js';
import { openDownloads, openDrawer, toggleSidebar, toggleTodo } from '../state/session.js';
import { Btn, Icon } from './ui.jsx';
import ContextRing from './ContextRing.jsx';

export default function Header() {
  const st = useApp();
  const settings = st.settings;
  const active = settings?.providers?.find((p) => p.id === settings.activeId) ?? settings?.providers?.[0] ?? null;
  const model = st.sessionMeta?.model || active?.model || '';

  const tone = !active ? 'bg-danger' : active.hasKey ? 'bg-ok' : 'bg-warn';
  const modelText = !active
    ? '未配置模型'
    : `${active.name}${model ? ` · ${model}` : ''}${active.hasKey ? '' : '（缺 key）'}`;

  const projectId = st.sessionMeta?.projectId ?? st.currentProjectId;
  const project = st.projects.find((p) => p.id === projectId);
  const title = st.sessionMeta?.title || '新会话';
  const sse = st.sse;
  const modelTitle = `当前模型：${modelText}${sse === 'open' ? '（事件流已连接）' : sse === 'error' ? '（事件流断开，浏览器会自动重连）' : ''} —— 点开改模型`;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel/80 px-3 backdrop-blur max-md:gap-1 max-md:px-2">
      {/* 手机左键：会话抽屉（宽屏隐藏，宽屏的会话列常驻左侧） */}
      <Btn variant="ghost" size="icon" className="md:hidden max-md:h-10 max-md:w-10" onClick={toggleSidebar} title="会话列表" aria-label="会话列表">
        <Icon name="menu" className="size-4" />
      </Btn>

      {/* ① 模型连接状态（宽屏一颗小圆点；手机上藏起来，要改模型走右侧设置抽屉） */}
      <button
        type="button"
        onClick={() => openDrawer('models')}
        title={modelTitle}
        className="flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11.5px] text-muted hover:bg-raise hover:text-fg max-md:hidden"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${tone}`} />
        <span className="max-w-[16rem] truncate">{modelText}</span>
      </button>

      <span className="shrink-0 text-subtle max-md:hidden">·</span>

      {/* ② 项目名称（手机：只留顶部标题，明细到会话抽屉里看分组） */}
      <span className="hidden shrink-0 items-center gap-1 text-[11.5px] text-subtle sm:flex" title="这个会话归属的项目（命令的工作目录）">
        <Icon name="folder" className="size-3" />
        <span className="max-w-[12rem] truncate">{project?.name ?? '不归属项目'}</span>
      </span>

      <span className="hidden shrink-0 text-subtle sm:inline">·</span>

      {/* ③ 会话名称 */}
      <span className="min-w-0 flex-1 truncate text-sm font-medium max-md:text-[13px]" title={title}>
        {title}
      </span>

      {/* ④ 上下文占用环（真分词；悬停看分解）—— 手机点不出悬停，收进右侧设置 */}
      <ContextRing className="max-md:hidden" />

      {sse !== 'open' ? (
        <span className="mr-1 hidden items-center gap-1.5 text-[11px] text-subtle sm:flex" title="事件流断开时界面不会实时更新，浏览器会自动重连">
          <span className={`size-1.5 rounded-full ${sse === 'error' ? 'bg-danger' : 'bg-subtle'}`} />
          {sse === 'error' ? '实时断开' : '未连'}
        </span>
      ) : null}
      {/* 待办 / 日志 / 待下载：宽屏照旧；手机只保留「待下载」（产物要能取走），
          待办与日志属于"过程信息"，手机上按需求不显示（消息里的折叠组已经能看操作） */}
      <Btn variant="ghost" size="sm" onClick={toggleTodo} title="任务清单（模型用 todo_write 维护）" className="max-md:hidden">
        <Icon name="clipboard" className="size-4" />
        <span className="hidden sm:inline">待办</span>
      </Btn>
      <Btn variant="ghost" size="sm" onClick={() => patch({ auditOpen: true })} title="看这条会话的事件日志（只追加的真源，可追溯）" className="max-md:hidden">
        <Icon name="clipboard" className="size-4" />
        <span className="hidden sm:inline">日志</span>
      </Btn>
      <Btn variant="ghost" size="sm" onClick={openDownloads} title="模型交付/抓取的文件" className="max-md:hidden">
        <Icon name="download" className="size-4" />
        <span className="hidden sm:inline">待下载</span>
      </Btn>

      {/* 手机右键：设置抽屉（宽屏是同一颗键，带文字） */}
      <Btn
        variant="ghost"
        size="sm"
        className="max-md:h-10 max-md:w-10 max-md:justify-center max-md:px-0"
        onClick={() => openDrawer()}
        title="设置：插件 / 记忆 / 技能 / 外部资源 / 提示词 / 项目 / 归档 / 主题 / 模型 / 系统"
        aria-label="设置"
      >
        <Icon name="sliders" className="size-4" />
        <span className="hidden sm:inline">设置</span>
      </Btn>
    </header>
  );
}
