/**
 * ui/features/SettingsDrawer.jsx —— 设置抽屉：六个板块一栏切换。
 *
 * 每个板块**自己拉自己的数据**（挂载时才请求，切走就丢），这样打开设置不会一次性
 * 把插件/记忆/技能/资源/提示词全拉一遍；各板块的保存动作也各管各的，互不影响。
 * 窄屏时抽屉占满整屏（手机上左侧那栏收成顶部的横向页签）。
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

const SECTIONS = [
  { id: 'plugins', name: '插件', icon: 'terminal' },
  { id: 'memory', name: '记忆', icon: 'brain' },
  { id: 'skills', name: '技能', icon: 'bulb' },
  { id: 'resources', name: '外部资源', icon: 'external' },
  { id: 'prompts', name: '提示词', icon: 'edit' },
  { id: 'projects', name: '项目', icon: 'folder' },
  { id: 'archive', name: '归档', icon: 'archive' },
  { id: 'theme', name: '主题', icon: 'palette' },
  { id: 'models', name: '模型与参数', icon: 'sliders' },
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
    : ModelsSection;

  return (
    <div className="fixed inset-0 z-50 flex bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && closeDrawer()}>
      <div className="ml-auto flex h-full w-full max-w-4xl flex-col border-l border-line bg-bg shadow-2xl md:flex-row">
        {/* 板块导航：宽屏在左、窄屏在顶 */}
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-2 py-2 md:w-44 md:flex-col md:items-stretch md:overflow-visible md:border-r md:border-b-0 md:py-3">
          <div className="hidden px-2 pb-2 md:block">
            <p className="text-sm font-medium">设置</p>
            <p className="text-[10.5px] text-subtle">改完即时生效（下一轮就按新配置走）</p>
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setDrawerSection(s.id)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors md:whitespace-normal ${section === s.id ? 'bg-raise text-fg' : 'text-muted hover:bg-raise/60 hover:text-fg'}`}
            >
              <Icon name={s.icon} className="size-3.5" />
              {s.name}
            </button>
          ))}
          <span className="flex-1" />
          <Btn variant="ghost" size="sm" onClick={closeDrawer} className="shrink-0 md:mt-auto">
            <Icon name="close" className="size-3.5" />
            关闭
          </Btn>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <Body />
        </div>
      </div>
    </div>
  );
}
