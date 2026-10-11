/**
 * ui/features/DiffView.jsx —— 代码软件风格的 diff 视图（统一 / 并排两种）。
 *
 * 参照 VS Code / GitHub 的做法，这几件是"看起来对"的关键：
 *   · **行号双列**（旧 | 新），新增行只占新列、删除行只占旧列，上下文两列都有；
 *   · 增删底色铺满整行（不只是文字变色）+ 左侧 1px 边条；
 *   · 等宽字体 + 不换行（横向滚动），折行会把"第几行"和视觉行对不上；
 *   · 中间那段没变的上下文折叠成「展开 N 行」，点开就地展开（不重新请求）；
 *   · 按文件分组，每个文件有自己的头（路径 + N/M + 展开/收起）。
 *
 * 数据来自服务端已经解析好的结构化 diff（GET /api/changes/diff 的 `files`），
 * 这里不解析字符串 —— 解析的边界情况在服务端统一处理（见 checkpoints.ts 的 parseUnifiedDiff）。
 */
import { useState } from 'react';
import { CONTEXT, splitRowsWithFolds, unifiedRows } from '../lib/diff-rows.js';
import { Icon, Spinner } from './ui.jsx';

/** 行号列：没有行号的那一侧留白（并排视图里对齐用） */
function Gutter({ n }) {
  return <span className="w-9 shrink-0 select-none border-r border-line/40 px-1.5 text-right text-[10.5px] leading-5 text-subtle/70 tabular-nums">{n ?? ''}</span>;
}

const MARK = { add: '+', del: '−', ctx: '' };

function Line({ line, side }) {
  /* 判空必须在最前面：并排视图里"这一侧本来就没内容"（对面是新增/删除）时
     line 是 null，先读 line.kind 会抛 TypeError，React 随即卸载整棵子树
     —— 表现是"一点「并排」抽屉就消失"，而不是某个格子画错。 */
  if (!line) return <div className={`flex min-h-5 flex-1 bg-raise/30 ${side === 'left' ? 'border-r border-line/40' : ''}`} />;
  const tone =
    line.kind === 'add'
      ? 'bg-ok/10 text-ok'
      : line.kind === 'del'
        ? 'bg-danger/10 text-danger'
        : 'text-muted';
  const bar = line.kind === 'add' ? 'border-l-2 border-ok/70' : line.kind === 'del' ? 'border-l-2 border-danger/70' : 'border-l-2 border-transparent';
  return (
    <div className={`flex min-h-5 items-stretch ${bar} ${tone} ${side === 'left' ? 'border-r border-line/40' : ''}`}>
      <Gutter n={side === 'left' ? line.oldNo : line.newNo} />
      <span className="w-3 shrink-0 select-none text-center text-[11px] leading-5 opacity-70">{MARK[line.kind]}</span>
      <span className="whitespace-pre px-1.5 leading-5">{line.text === '' ? ' ' : line.text}</span>
    </div>
  );
}

/** 折叠条：点一下把这段上下文就地摊开 */
function FoldBar({ count, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-1.5 border-y border-line/40 bg-raise/40 px-2 py-0.5 text-left text-[10.5px] text-subtle transition-colors hover:bg-raise/70 hover:text-fg"
    >
      <Icon name="chevron-down" className="size-3" />
      展开 {count} 行未改动的上下文
    </button>
  );
}

/** 一个文件块 */
function FileBlock({ file, view }) {
  const [open, setOpen] = useState(true);
  const [expandAll, setExpandAll] = useState(false);
  const name = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-bg/60">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-card px-2.5 py-1.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={open ? '收起这个文件' : '展开这个文件'}>
          <Icon name="chevron" className={`size-3 shrink-0 text-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
          <Icon name="file" className="size-3.5 shrink-0 text-subtle" />
          <span className="truncate font-mono text-[11.5px] text-fg">{name}</span>
        </button>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
          {file.added ? <span className="text-ok">+{file.added}</span> : null}
          {file.removed ? <span className="text-danger">−{file.removed}</span> : null}
        </span>
        {open && !file.binary && file.lines.length > CONTEXT * 3 ? (
          <button type="button" onClick={() => setExpandAll((v) => !v)} className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-subtle transition-colors hover:bg-raise hover:text-fg">
            {expandAll ? '折叠上下文' : '展开全部'}
          </button>
        ) : null}
      </header>

      {open ? (
        file.binary ? (
          <p className="px-3 py-2 text-[11px] text-subtle">二进制文件，不显示逐行内容。</p>
        ) : !file.lines.length ? (
          <p className="px-3 py-2 text-[11px] text-subtle">只有模式/重命名之类的元信息变化，没有内容差异。</p>
        ) : (
          /* 横向滚动容器：代码不折行（折了就跟行号对不上） */
          <div className="thin-scroll overflow-x-auto py-1 font-mono text-[11.5px]">
            {view === 'split' ? <SplitBody lines={file.lines} expandAll={expandAll} /> : <UnifiedBody lines={file.lines} expandAll={expandAll} />}
          </div>
        )
      ) : null}
    </section>
  );
}

function UnifiedBody({ lines, expandAll }) {
  const [opened, setOpened] = useState(() => new Set());
  const rows = unifiedRows(lines, { expandAll });
  return (
    <div className="min-w-max">
      {rows.map((r, i) =>
        r.type === 'fold' ? (
          opened.has(r.from) ? (
            lines.slice(r.from, r.to).map((line, k) => <Line key={`e${r.from}-${k}`} line={line} />)
          ) : (
            <FoldBar
              key={`f${r.from}-${i}`}
              count={r.count}
              onOpen={() => setOpened((s) => new Set(s).add(r.from))}
            />
          )
        ) : (
          <Line key={i} line={r.line} />
        ),
      )}
    </div>
  );
}

function SplitBody({ lines, expandAll }) {
  const [opened, setOpened] = useState(() => new Set());
  const openFold = (from) => setOpened((s) => new Set(s).add(from));
  const rows = splitRowsWithFolds(lines, { expandAll, opened });
  return (
    <div className="min-w-max">
      {rows.map((r, i) =>
        r.fold ? (
          /* 折叠条横跨两栏：左右各一个（点哪边都展开），中间用列分隔线对齐 */
          <div key={`f${r.fold.from}`} className="flex w-full">
            <div className="w-[50%] shrink-0 border-r border-line/40">
              <FoldBar count={r.fold.count} onOpen={() => openFold(r.fold.from)} />
            </div>
            <div className="w-[50%] shrink-0">
              <FoldBar count={r.fold.count} onOpen={() => openFold(r.fold.from)} />
            </div>
          </div>
        ) : (
          <SplitLine key={i} row={r} />
        ),
      )}
    </div>
  );
}

function SplitLine({ row }) {
  return (
    <div className="flex min-w-max">
      <div className="flex w-[50%] shrink-0">
        <Line line={row.left} side="left" />
      </div>
      <div className="flex w-[50%] shrink-0">
        <Line line={row.right} side="right" />
      </div>
    </div>
  );
}

export default function DiffView({ detail, loading, error, empty = '这里没有文件差异。' }) {
  const [view, setView] = useState('unified');
  if (loading) {
    return (
      <p className="flex items-center gap-2 px-1 py-3 text-xs text-subtle">
        <Spinner className="size-3.5" />
        正在取 diff…
      </p>
    );
  }
  if (error) return <p className="px-1 py-3 text-xs text-danger">{error}</p>;
  if (!detail) return null;
  const files = detail.files ?? [];
  if (!files.length) return <p className="px-1 py-3 text-xs text-subtle">{empty}</p>;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 text-[11px] text-subtle">
        <span className="tabular-nums">
          {detail.stat?.files ?? files.length} 个文件
        </span>
        <span className="text-ok">+{detail.stat?.added ?? 0}</span>
        <span className="text-danger">−{detail.stat?.removed ?? 0}</span>
        <span className="flex-1" />
        <div className="flex items-center rounded-md border border-line p-0.5">
          {[
            ['unified', '统一'],
            ['split', '并排'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`rounded px-2 py-0.5 text-[10.5px] transition-colors ${view === id ? 'bg-raise text-fg' : 'text-subtle hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {files.map((f) => (
          <FileBlock key={f.path + (f.oldPath ?? '')} file={f} view={view} />
        ))}
      </div>
    </div>
  );
}
