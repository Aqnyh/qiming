/**
 * ui/features/SettingsDrawer.jsx —— 设置抽屉：十个板块一栏切换。
 *
 * 每个板块**自己拉自己的数据**（挂载时才请求，切走就丢），这样打开设置不会一次性
 * 把插件/记忆/技能/资源/提示词全拉一遍；各板块的保存动作也各管各的，互不影响。
 *
 * 手机（<md）三处适配（2026-10-10）：抽屉占满整屏（顶栏那颗齿轮键就开它）、
 * 顶部一条固定的「设置 / 关闭」行（关掉它不必回头量右上角，也避开刘海），
 * 板块页签加大点击面积（h-12 的横向滚动条，手指点得中）。
 */
import { useApp } from '../state/store.js';
import { closeDrawer, setDrawerSection } from '../state/session.js';
import { Btn, Icon } from './ui.jsx';
import PluginsSection from './settings/PluginsSection.jsx';
import MemorySection from './settings/MemorySection.jsx';
import SkillsSection from './settings/SkillsSection.jsx';
import ResourcesSection from './settings/ResourcesSection.jsx';
import PromptsSection from './settings/PromptsSection.jsx';
import ProjectsSection from './settings/ProjectsSection.jsx';
import ArchiveSection from './settings/ArchiveSection.jsx';
import ThemeSection from './settings/ThemeSection.jsx';
import ModelsSection from './settings/ModelsSection.jsx';
import SystemSection from './settings/SystemSection.jsx';

const SECTIONS = [
  { id: 'plugins', name: '插件', icon: 'terminal' },
  { id: 'memory', name: '记忆', icon: 'brain' },
  { id: 'skills', name: '技能', icon: 'bulb' },
  { id: 'resources', name: '外部资源', icon: 'external' },
  { id: 'prompts', name: '提示词', icon: 'edit' },
  { id: 'projects', name: '项目', icon: 'folder' },
  { id: 'archive', name: '归档', icon: 'archive' },
  { id: 'theme', name: '主题', icon: 'palette' },
  { id: 'models', name: '模型', icon: 'sliders' },
  { id: 'system', name: '系统', icon: 'cog' },
];

export default function SettingsDrawer() {
  const st = useApp();
  const section = st.drawer.section;
  const Body =
    section === 'plugins' ? PluginsSection
    : section === 'memory' ? MemorySection
    : section === 'skills' ? SkillsSection
    : section === 'resources' ? ResourcesSection
    : section === 'prompts' ? PromptsSection
    : section === 'projects' ? ProjectsSection
    : section === 'archive' ? ArchiveSection
    : section === 'theme' ? ThemeSection
    : section === 'system' ? SystemSection
    : ModelsSection;

  return (
    <div className="fixed inset-0 z-50 flex bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && closeDrawer()}>
      <div className="ml-auto flex h-full w-full max-w-4xl flex-col border-l border-line bg-bg shadow-2xl md:flex-row">
        {/* 手机：固定的标题行（宽屏由左侧导航自己的头部承担，这里整行隐藏） */}
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 md:hidden">
          <Icon name="sliders" className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-sm font-medium">设置</span>
            <span className="block truncate text-[10.5px] text-subtle">改完即时生效（下一轮就按新配置走）</span>
          </span>
          <Btn variant="ghost" size="sm" onClick={closeDrawer} className="h-10 shrink-0 px-3" aria-label="关闭设置">
            <Icon name="close" className="size-4" />
            关闭
          </Btn>
        </header>

        {/* 板块导航：宽屏在左、手机在顶部（手机横向滚动的页签，点得中就行） */}
        <div className="thin-scroll flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-2 py-2 max-md:py-1.5 md:w-44 md:flex-col md:items-stretch md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:py-3">
          <div className="hidden px-2 pb-2 md:block">
            <p className="text-sm font-medium">设置</p>
            <p className="text-[10.5px] text-subtle">改完即时生效（下一轮就按新配置走）</p>
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              data-section={s.id}
              onClick={() => setDrawerSection(s.id)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors max-md:h-11 max-md:flex-col max-md:gap-0.5 max-md:px-3 max-md:py-1 ${section === s.id ? 'bg-raise text-fg max-md:text-accent' : 'text-muted hover:bg-raise/60 hover:text-fg'} md:whitespace-normal md:flex-row`}
            >
              <Icon name={s.icon} className="size-3.5 max-md:size-4" />
              {s.name}
            </button>
          ))}
          <span className="flex-1 max-md:hidden" />
          {/* 宽屏的关闭键（手机用顶部那一行，这里隐藏） */}
          <Btn variant="ghost" size="sm" onClick={closeDrawer} className="hidden shrink-0 md:mt-auto md:flex">
            <Icon name="close" className="size-3.5" />
            关闭
          </Btn>
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:p-2.5">
          <Body />
        </div>
      </div>
    </div>
  );
}
