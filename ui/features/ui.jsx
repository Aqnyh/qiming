/**
 * ui/features/ui.jsx —— 界面共用件：图标、按钮、输入框、开关、弹层、Toast。
 *
 * 为什么不引组件库（radix/lucide 等）：需求明确"不要新增依赖"。
 * 这里每个件都只服务本工程，内联 SVG 图标省掉一整个依赖树与一次构建体积。
 */
import { useEffect } from 'react';
import { hideToast } from '../state/store.js';

/* ────────────────────────── 图标（内联 SVG，线性风格） ────────────────────────── */

const PATHS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  close: 'M18 6 6 18M6 6l12 12',
  chevron: 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  stop: 'M7 7h10v10H7z',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 15h10l1-15',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  bulb: 'M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 0 0 18 8 6 6 0 0 0 6 8c0 1.4.5 2.6 1.5 3.5.8.8 1.3 1.6 1.5 2.5M9 18h6M10 22h4',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  clipboard: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 14l2 2 4-4',
  refresh: 'M21 12a9 9 0 0 0-15-6.7L3 8M3 3v5h5M3 12a9 9 0 0 0 15 6.7L21 16M21 21v-5h-5',
  check: 'M20 6 9 17l-5-5',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  upload: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  play: 'M8 5v14l11-7z',
  up: 'M12 19V5M5 12l7-7 7 7',
  pin: 'M9 4h6v6l3 3H6l3-3zM12 13v7',
  archive: 'M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM2 4h20v4H2zM10 12h4',
  palette: 'M12 22a10 10 0 1 1 10-10c0 2.5-2 3-3.5 3H16a2 2 0 0 0-1.5 3.3A2 2 0 0 1 12 22zM7.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 8.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM16.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  zap: 'M13 2 3 14h8l-1 8 10-12h-8z',
  queue: 'M4 6h16M4 12h10M4 18h7M17 13l4 4-4 4',
  brain: 'M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 4 17.5a2.5 2.5 0 0 1-1.34-4.5A2.5 2.5 0 0 1 3 8.5a2.5 2.5 0 0 1 1.34-4.5A2.5 2.5 0 0 1 9.5 2zM14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 20 17.5a2.5 2.5 0 0 0 1.34-4.5A2.5 2.5 0 0 0 21 8.5a2.5 2.5 0 0 0-1.34-4.5A2.5 2.5 0 0 0 14.5 2z',
  diff: 'M12 3v18M7 8h10M7 12h10M7 16h6',
  undo: 'M3 7v6h6M3.5 13a9 9 0 1 0 2.1-6.4L3 9',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
};

export function Icon({ name, className = 'size-4', strokeWidth = 1.7 }) {
  const d = PATHS[name] ?? PATHS.file;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Spinner({ className = 'size-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ────────────────────────── 基础控件 ────────────────────────── */

const BTN = {
  primary: 'bg-accent text-[#04201c] hover:bg-accent-strong font-medium',
  outline: 'border border-line text-fg hover:bg-raise',
  ghost: 'text-muted hover:text-fg hover:bg-raise',
  danger: 'border border-danger/40 text-danger hover:bg-danger/10',
};

export function Btn({ variant = 'outline', size = 'md', className = '', children, ...rest }) {
  const sizes = { sm: 'h-7 px-2 text-xs gap-1', md: 'h-9 px-3 text-sm gap-1.5', icon: 'h-8 w-8 justify-center' };
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex select-none items-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BTN[variant] ?? BTN.outline} ${sizes[size] ?? sizes.md} ${className}`}
    >
      {children}
    </button>
  );
}

const INPUT = 'w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm text-fg placeholder:text-subtle outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20';

export function Input({ className = '', ...rest }) {
  return <input {...rest} className={`${INPUT} ${className}`} />;
}

export function Area({ className = '', ...rest }) {
  return <textarea {...rest} className={`${INPUT} font-mono text-xs leading-relaxed ${className}`} />;
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select {...rest} className={`${INPUT} ${className}`}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-relaxed text-subtle">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${checked ? 'bg-accent' : 'bg-raise border border-line'}`}
    >
      <span className={`block size-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
    </button>
  );
}

export function Badge({ children, tone = 'default', className = '' }) {
  const tones = {
    default: 'border-line text-muted',
    ok: 'border-ok/40 text-ok',
    warn: 'border-warn/40 text-warn',
    danger: 'border-danger/40 text-danger',
    accent: 'border-accent/40 text-accent',
  };
  return <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none ${tones[tone] ?? tones.default} ${className}`}>{children}</span>;
}

/** 弹层（居中卡片）；Esc 与点背景关闭 */
export function Modal({ title, onClose, children, wide = false, footer = null }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium text-fg">{title}</h2>
          <span className="flex-1" />
          <Btn variant="ghost" size="icon" onClick={onClose} title="关闭">
            <Icon name="close" className="size-4" />
          </Btn>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? <div className="shrink-0 border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

/** 设置页里的一块（标题 + 说明 + 内容） */
export function Section({ title, desc, actions = null, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-line bg-panel/60 p-3 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-fg">{title}</h3>
        <span className="flex-1" />
        {actions}
      </div>
      {desc ? <p className="mb-2 text-[11px] leading-relaxed text-subtle">{desc}</p> : null}
      {children}
    </section>
  );
}

/** 解析 JSON 文本；失败时返回 { error }。设置的 JSON 输入框都用它做即时校验 */
export function tryParseJson(text, fallback) {
  const raw = String(text ?? '').trim();
  if (!raw) return { value: fallback };
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return { error: `JSON 解析失败：${err.message}` };
  }
}

/** 全局 Toast（store.toast 驱动） */
export function Toast({ toast }) {
  if (!toast) return null;
  const tone = toast.kind === 'error' ? 'border-danger/50 bg-danger/10 text-danger' : toast.kind === 'ok' ? 'border-ok/40 bg-ok/10 text-ok' : 'border-line bg-card text-fg';
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] w-[min(92vw,40rem)] -translate-x-1/2">
      <div className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-3 py-2 text-sm shadow-2xl backdrop-blur ${tone}`}>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{toast.text}</span>
        <button type="button" onClick={hideToast} className="shrink-0 opacity-60 hover:opacity-100" title="关掉">
          <Icon name="close" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
