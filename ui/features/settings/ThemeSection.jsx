/**
 * ui/features/settings/ThemeSection.jsx —— 主题（需求 1）。
 *
 * 参照主流 harness 的外观设置（主题模式 / 强调色 / 背景 / 字体 / 字号），
 * 每一项都是"改一下就立刻看到"——不按保存按钮，改动先本地应用（applyTheme），
 * 半秒后落盘（POST /api/settings {ui}）。这样用户是在"看着调"，而不是"猜着配"。
 *
 * 落盘走防抖：滑杆拖一次会产生几十个事件，每个都发一次请求既慢又吵。
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../state/api.js';
import { useApp, patch, toast } from '../../state/store.js';
import { applyTheme, BACKGROUNDS, ACCENTS, FONT_MONO, FONT_SANS, THEME_DEFAULTS, THEME_MODES, watchSystemTheme } from '../../state/theme.js';
import { Btn, Field, Icon, Input, Section, Select } from '../ui.jsx';

export default function ThemeSection() {
  const st = useApp();
  const [ui, setUi] = useState(() => ({ ...THEME_DEFAULTS, ...(st.settings?.ui ?? {}) }));
  const timer = useRef(null);

  // 应用到 <html>（每次改动都立即生效，不等服务端）
  useEffect(() => {
    applyTheme(ui);
    watchSystemTheme(ui);
  }, [ui]);

  const change = (key, value) => {
    const next = { ...ui, [key]: value };
    setUi(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), 400);
  };

  const save = async (next) => {
    try {
      const r = await api('/api/settings', { method: 'POST', body: { ui: next } });
      patch({ settings: r });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const reset = () => {
    const next = { ...THEME_DEFAULTS };
    setUi(next);
    void save(next);
    toast('外观已恢复默认', 'ok');
  };

  const isLight = ui.mode === 'light';

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="主题"
        desc="改动立即生效并自动保存（不用点保存）。设置存在服务端，本机所有浏览器共用这一套外观。"
        actions={
          <Btn size="sm" onClick={reset}>
            <Icon name="refresh" className="size-3" />
            恢复默认
          </Btn>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="主题模式" hint="跟随系统会随桌面深浅色自动切换">
            <Select value={ui.mode} onChange={(e) => change('mode', e.target.value)}>
              {THEME_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="强调色" hint="按钮、链接、进度这些「活」的元素用它">
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  title={a.name}
                  onClick={() => change('accent', a.id)}
                  className={`size-6 rounded-full border-2 transition-transform hover:scale-110 ${ui.accent === a.id ? 'border-fg' : 'border-transparent'}`}
                  style={{ background: a.color }}
                />
              ))}
            </div>
          </Field>

          <Field label="背景">
            <Select value={ui.bg} onChange={(e) => change('bg', e.target.value)}>
              {BACKGROUNDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="字号" hint={`根字号 ${ui.fontSize}px（整体等比缩放）`}>
            <input
              type="range"
              min={13}
              max={20}
              step={1}
              value={ui.fontSize}
              onChange={(e) => change('fontSize', Number(e.target.value))}
              className="w-full accent-[var(--color-accent)]"
            />
          </Field>

          <Field label="界面字体">
            <Select value={ui.fontSans} onChange={(e) => change('fontSans', e.target.value)}>
              <option value="system">系统默认</option>
              <option value="noto">Noto Sans CJK（思源黑体）</option>
              <option value="serif">衬线（宋体/Noto Serif）</option>
              <option value="monoAll">全站等宽</option>
            </Select>
          </Field>

          <Field label="代码字体">
            <Select value={ui.fontMono} onChange={(e) => change('fontMono', e.target.value)}>
              {Object.keys(FONT_MONO).map((k) => (
                <option key={k} value={k}>
                  {k === 'system' ? '系统等宽' : k === 'dejavu' ? 'DejaVu Sans Mono' : 'Noto Sans Mono'}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="会话列宽"
            hint={Number(ui.chatWidth) > 0 ? `${ui.chatWidth}rem —— 消息区与输入框共用这个宽度` : '不限（跟随窗口宽度）—— 往右拖可收窄'}
          >
            <input
              type="range"
              min={0}
              max={140}
              step={2}
              value={ui.chatWidth ?? 0}
              onChange={(e) => change('chatWidth', Number(e.target.value))}
              className="w-full accent-[var(--color-accent)]"
            />
          </Field>

          {ui.bg === 'image' ? (
            <>
              <Field label="背景图地址" hint="本地文件用 file:// 可能被浏览器拦，建议放 public/ 下或用 http 地址">
                <Input value={ui.bgImage} onChange={(e) => change('bgImage', e.target.value)} placeholder="https://… 或 /bg.jpg" />
              </Field>
              <Field label="背景压暗" hint={`${Math.round((ui.bgDim ?? 0.86) * 100)}%（越高文字越清楚）`}>
                <input
                  type="range"
                  min={0}
                  max={0.95}
                  step={0.05}
                  value={ui.bgDim ?? 0.86}
                  onChange={(e) => change('bgDim', Number(e.target.value))}
                  className="w-full accent-[var(--color-accent)]"
                />
              </Field>
            </>
          ) : null}
        </div>

        {/* 小预览：一眼看清当前配色与字体（不用先切出去看整个界面） */}
        <div className="mt-3 rounded-xl border border-line bg-bg p-3">
          <p className="text-[11px] text-subtle">预览</p>
          <p className="mt-1 text-sm">
            这是正文样式，<span className="text-accent underline">链接</span>与
            <code className="mx-1 rounded border border-line bg-raise px-1 font-mono text-[0.86em]">inline code</code>
            也在其中。
          </p>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-card p-2 font-mono text-[0.8rem]">
{`$ echo "当前主题：${ui.mode} / ${ui.accent} / ${isLight ? '浅色' : '深色'}"
theme: ${ui.mode}  accent: ${ui.accent}  font: ${ui.fontSans}  size: ${ui.fontSize}px`}
          </pre>
        </div>
      </Section>

      <p className="text-[11px] leading-relaxed text-subtle">
        字体选项对应本机已装字体（{Object.keys(FONT_SANS).length} 种 UI 字体 / {Object.keys(FONT_MONO).length} 种等宽字体），
        没装的字体浏览器会自动回退，不会出现方框。
      </p>
    </div>
  );
}
