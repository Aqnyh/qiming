/**
 * ui/features/ContextRing.jsx —— 顶栏的上下文占用环。
 *
 * 做法对齐主流 harness（Claude Code 的 context 指示器、Cursor 的用量条）：
 *   · 常驻、极简：一个环 + 百分比，不占版面；
 *   · **颜色分级**：<70% 中性、70–85% 警告、≥85% 危险 —— 到危险区间就该提醒用户
 *     "该开新会话了"，而不是等模型被静默截断（旧做法只按字数估，中文能少算 60%）；
 *   · 悬停给**分解**：系统提示词 / 历史消息 / 工具表 / 预留输出各占多少，
 *     这样"为什么占了这么多"能一眼看出来（工具表往往是意外的大头）；
 *   · 数字全部来自服务端真分词（见 src/agent/count.ts），前端不做任何估算。
 *
 * **悬停展开的分解在手机上没有意义**（点不出 hover），所以手机（<md）由调用方
 * 传 `className="max-md:hidden"` 把它整颗收进设置 —— 见 Header.jsx。
 *
 * 没有数据时不渲染（还没跑过、或服务端没配上下文上限）。
 */
import { useApp } from '../state/store.js';
import { fmtCount } from '../lib/format.js';

/** 分级阈值：与后端 75% 的压缩阈值错开，让"变黄"先于"开始压缩"出现 */
const WARN = 70;
const DANGER = 85;

function tone(percent) {
  if (percent >= DANGER) return { ring: 'text-danger', text: 'text-danger', label: '接近上限' };
  if (percent >= WARN) return { ring: 'text-warn', text: 'text-warn', label: '偏高' };
  return { ring: 'text-accent', text: 'text-muted', label: '充足' };
}

export default function ContextRing({ className = '' }) {
  const st = useApp();
  const usage = st.activeId ? st.usage[st.activeId] : null;
  if (!usage || !usage.limit) return null;

  const percent = Math.max(0, Math.min(100, Number(usage.percent) || 0));
  const t = tone(percent);
  const R = 7.5;
  const C = 2 * Math.PI * R;
  const dash = (percent / 100) * C;

  const rows = [
    ['系统提示词', usage.system],
    ['历史消息', usage.messages],
    ['工具表', usage.tools],
    ['预留输出', usage.reserve],
  ];

  return (
    <div
      className={`group/ctx relative flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11.5px] hover:bg-raise ${className}`}
      title={`上下文占用 ${percent}%（真分词计数，${usage.encoding}）`}
    >
      <svg viewBox="0 0 20 20" className={`size-4 shrink-0 ${t.ring}`} aria-hidden="true">
        <circle cx="10" cy="10" r={R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <circle
          cx="10"
          cy="10"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${C - dash}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span className={`tabular-nums ${t.text}`}>{percent}%</span>

      {/* 悬停展开分解：为什么占了这么多，一眼看清 */}
      <div className="pointer-events-none absolute top-full right-0 z-30 hidden w-60 rounded-lg border border-line bg-panel p-2.5 text-[11px] shadow-lg group-hover/ctx:block">
        <p className="mb-1.5 flex items-center justify-between font-medium text-fg">
          <span>上下文占用</span>
          <span className={`tabular-nums ${t.text}`}>
            {fmtCount(usage.used)} / {fmtCount(usage.limit)}
          </span>
        </p>
        {rows.map(([label, n]) => (
          <p key={label} className="flex items-center justify-between py-0.5 text-muted">
            <span>{label}</span>
            <span className="tabular-nums">{fmtCount(n)}</span>
          </p>
        ))}
        <p className="mt-1.5 border-t border-line pt-1.5 text-subtle">
          剩余 {fmtCount(usage.left)} · {t.label}（{Math.round(percent)}% 处{percent >= WARN ? '，建议尽快收尾或开新会话' : ''}）
        </p>
      </div>
    </div>
  );
}
