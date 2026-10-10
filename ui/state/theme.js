/**
 * ui/state/theme.js —— 主题应用（唯一落点）。
 *
 * 做法：把用户选择写成 <html> 上的 data-* 属性与几个 CSS 变量，styles.css 里按属性覆盖
 * Tailwind 的 --color-* 令牌 —— 于是换肤不需要重建 CSS、也不需要任何组件感知主题。
 *
 * settings.ui 里保存的字段（都是可选的，缺了用默认）：
 *   mode: 'dark' | 'light' | 'system'      accent: teal|blue|violet|amber|rose|green
 *   bg: 'solid' | 'aurora' | 'grid' | 'image'    bgImage: 图片 URL    bgDim: 图片上那层底色的不透明度
 *   fontSize: 14–20（px，改根字号 → rem 全部跟着缩放）   chatWidth: 44–90（rem，消息区与输入框共用）
 *   fontSans / fontMono: 见下面的表
 */

export const THEME_DEFAULTS = {
  mode: 'dark',
  accent: 'teal',
  bg: 'solid',
  bgImage: '',
  bgDim: 0.86,
  fontSize: 16,
  /** 会话列宽（rem）；**0 = 不限**（跟随窗口宽度，默认） */
  chatWidth: 0,
  fontSans: 'system',
  fontMono: 'system',
};

/** UI 字体（都带完整的 CJK 回退链，缺字体也不会变方框） */
export const FONT_SANS = {
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  noto: '"Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Noto Serif CJK SC", "Songti SC", "SimSun", serif',
  monoAll: '"SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", "Noto Sans Mono", monospace',
};

/** 代码字体 */
export const FONT_MONO = {
  system: '"SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace',
  dejavu: '"DejaVu Sans Mono", ui-monospace, Menlo, Consolas, monospace',
  noto: '"Noto Sans Mono", "Noto Mono", ui-monospace, Menlo, monospace',
};

export const THEME_MODES = [
  { id: 'dark', name: '深色' },
  { id: 'light', name: '浅色' },
  { id: 'system', name: '跟随系统' },
];

export const ACCENTS = [
  { id: 'teal', name: '青绿', color: '#2dd4bf' },
  { id: 'blue', name: '湖蓝', color: '#60a5fa' },
  { id: 'violet', name: '紫罗兰', color: '#a78bfa' },
  { id: 'amber', name: '琥珀', color: '#fbbf24' },
  { id: 'rose', name: '玫红', color: '#fb7185' },
  { id: 'green', name: '草绿', color: '#4ade80' },
];

export const BACKGROUNDS = [
  { id: 'solid', name: '纯色' },
  { id: 'aurora', name: '极光渐变' },
  { id: 'grid', name: '细网格' },
  { id: 'image', name: '自定义图片' },
];

function prefersLight() {
  return Boolean(window.matchMedia?.('(prefers-color-scheme: light)').matches);
}

/** 把主题写到 <html>；返回"当前实际是深色还是浅色"（跟随系统时有用） */
export function applyTheme(ui) {
  const t = { ...THEME_DEFAULTS, ...(ui ?? {}) };
  const el = document.documentElement;
  const dark = t.mode === 'light' ? false : t.mode === 'system' ? !prefersLight() : true;
  el.dataset.theme = dark ? 'dark' : 'light';
  el.dataset.accent = ACCENTS.some((a) => a.id === t.accent) ? t.accent : THEME_DEFAULTS.accent;
  el.dataset.bg = BACKGROUNDS.some((b) => b.id === t.bg) ? t.bg : 'solid';

  el.style.setProperty('--base-size', `${clamp(Number(t.fontSize) || 16, 13, 22)}px`);
  const cw = Number(t.chatWidth) || 0;
  el.style.setProperty('--chat-max', cw > 0 ? `${clamp(cw, 40, 200)}rem` : 'none');
  el.style.setProperty('--font-sans', FONT_SANS[t.fontSans] ?? FONT_SANS.system);
  el.style.setProperty('--font-mono', FONT_MONO[t.fontMono] ?? FONT_MONO.system);
  if (t.bg === 'image' && t.bgImage) el.style.setProperty('--app-bg-image', `url("${String(t.bgImage).replace(/"/g, '%22')}")`);
  else el.style.removeProperty('--app-bg-image');
  el.style.setProperty('--app-bg-dim', String(clamp(Number(t.bgDim) ?? 0.86, 0, 0.98)));
  return dark;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 「跟随系统」时监听系统切换。
 * 只在 mode==='system' 时挂监听（其它模式挂上就是白占一个订阅），
 * 所以每次 apply 都先退订上一次。
 */
let offSystem = null;
export function watchSystemTheme(ui) {
  if (offSystem) {
    offSystem();
    offSystem = null;
  }
  const mode = ui?.mode ?? THEME_DEFAULTS.mode;
  if (mode !== 'system' || !window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const fn = () => applyTheme(ui);
  mq.addEventListener('change', fn);
  offSystem = () => mq.removeEventListener('change', fn);
}
