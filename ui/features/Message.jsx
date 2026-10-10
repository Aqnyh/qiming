/**
 * ui/features/Message.jsx —— 单条消息。
 *
 * 助手消息的结构（固定顺序，与需求 5 对齐）：
 *   灰字提示（notice）→ 思考（折叠行）→ 操作（折叠组）→ 交付文件卡 → 正文（Markdown）→ 元信息
 *  · 思考折叠行显示「思考 · N 字」，流式中显示最后一行预览；**点击展开时**才
 *    用 `GET /api/run/{runId}/thinking/{msgId}` 取全文（流式中文件还没落盘时用本地预览兜底，
 *    并如实说明"全文会在运行结束后可取"）；
 *  · 操作组默认收起（TraceGroup.jsx），文件卡在组**外面**——交付物是产出，收起也要看得见。
 *
 * 用户消息：右侧气泡；运行中的插话带「插话」标记。
 */
import { memo, useState } from 'react';
import { api, fileUrl } from '../state/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { baseName, fileKind, fmtChars, fmtDuration, fmtWhen, statsLine } from '../lib/format.js';
import { buildParts } from '../lib/message-parts.js';
import TraceGroup from './TraceGroup.jsx';
import { Badge, Icon, Spinner } from './ui.jsx';
import { useApp } from '../state/store.js';

/** 思考折叠行：字数来自服务端消息（全文）或流式计数；展开时才取全文 */
function Thinking({ msg, streaming }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const runId = msg.runId;
  const tail = String(msg.thinkingTail ?? '');
  const chars = text !== null ? text.length : (msg.thinking?.length || msg.thinkingChars || 0);
  const preview = streaming
    ? tail
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() ?? ''
    : '';

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (text !== null || loading) return;
    setLoading(true);
    setErr('');
    try {
      let full = '';
      if (runId) {
        // 点开才取：事件流里只有预览，全文一直在服务端（data/runs/<runId>/thinking/<msgId>.md）
        full = (await api(`/api/run/${encodeURIComponent(runId)}/thinking/${encodeURIComponent(msg.id)}`)).text ?? '';
      }
      // 流式中文件尚未落盘（运行结束才写），用手里那点预览兜底，别让用户点开是空的
      if (!full) full = msg.thinking || tail || '（还没有思考内容）';
      if (streaming && !full.trim()) setErr('思考全文要等这段运行结束后才能取回。');
      setText(full);
    } catch (e) {
      setErr(e?.message ?? String(e));
      setText(msg.thinking || tail || '');
    } finally {
      setLoading(false);
    }
  };

  if (!chars && !streaming) return null;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={toggle}
        title={open ? '收起思考' : '展开看思考全文（点击时才从服务端取）'}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1 py-0.5 text-left text-xs text-subtle hover:bg-raise/40 hover:text-muted"
      >
        <Icon name="chevron" className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon name="bulb" className="size-3.5 shrink-0" />
        <span className="shrink-0">思考 · {fmtChars(chars)}</span>
        {preview ? <span className="min-w-0 flex-1 truncate opacity-70">{preview}</span> : <span className="flex-1" />}
      </button>
      {open ? (
        <div className="mt-1 rounded-lg border border-line/60 bg-panel/40 p-2">
          {loading ? (
            <p className="flex items-center gap-1.5 text-[11px] text-subtle">
              <Spinner className="size-3" />
              正在取思考全文…
            </p>
          ) : (
            <pre className="thin-scroll max-h-80 overflow-auto font-sans text-xs leading-relaxed whitespace-pre-wrap text-muted">{text ?? '（空）'}</pre>
          )}
          {err ? <p className="mt-1 text-[11px] text-warn">{err}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 一个交付文件的卡片：图片/视频/音频内联，其余给下载链接 */
function FileCard({ file }) {
  const name = baseName(file);
  const kind = fileKind(name);
  const inline = fileUrl(name, true);
  const dl = fileUrl(name, false);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel/60">
      {kind === 'image' ? (
        <a href={inline} target="_blank" rel="noreferrer noopener" title={`打开 ${name}`}>
          <img src={inline} alt={name} loading="lazy" className="max-h-64 w-full bg-black/30 object-contain" />
        </a>
      ) : null}
      {kind === 'video' ? <video src={inline} controls preload="metadata" className="max-h-64 w-full bg-black/40" /> : null}
      {kind === 'audio' ? <audio src={inline} controls preload="metadata" className="w-full px-2 pt-2" /> : null}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Icon name={kind === 'image' ? 'image' : kind === 'video' ? 'play' : 'file'} className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={file}>
          {name}
        </span>
        <a href={dl} download className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-accent hover:bg-accent/10" title="下载">
          <Icon name="download" className="size-3" />
          下载
        </a>
      </div>
    </div>
  );
}

/**
 * 交付文件卡：**只渲染待下载目录里的文件**（deliver_file 放进去的、资源动作 saveAs 抓回来的）。
 * 为什么按目录过滤而不是按工具名：历史记录里混着"文件工具碰过的路径"（旧版本的 bug），
 * 按目录过滤能让旧记录也自愈 —— 那些卡本来点下载就是 404。
 */
function CallFiles({ files, downloadsDir }) {
  const real = (files ?? []).filter((f) => f && downloadsDir && String(f).startsWith(downloadsDir));
  const list = [...new Set(real.map((f) => baseName(f)).filter(Boolean))];
  if (!list.length) return null;
  return (
    <div className="my-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((f) => (
        <FileCard key={f} file={f} />
      ))}
    </div>
  );
}

/**
 * 媒体卡：模型用 send_media 发来的图片/视频/音频，直接渲染成看得见的东西。
 * 两种来源：`url`（外部链接，浏览器直接加载）与 `download`（待下载目录里的文件名 ——
 * 令牌只在浏览器里，所以由前端用 fileUrl() 补上，服务端给不出可用的完整地址）。
 * 加载失败就退化成一行链接（图挂了也不至于什么都看不到）。
 */
function MediaCard({ m }) {
  const [failed, setFailed] = useState(false);
  const src = m?.url || (m?.download ? fileUrl(m.download, true) : '');
  if (!src) return null;
  const name = m.download || m.url;
  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-card">
      {failed ? (
        <div className="px-3 py-2 text-xs text-subtle">
          加载失败：
          <a href={src} target="_blank" rel="noreferrer" className="break-all text-accent underline">
            {name}
          </a>
        </div>
      ) : m.kind === 'video' ? (
        <video src={src} controls preload="metadata" className="max-h-[60dvh] w-full bg-black" onError={() => setFailed(true)} />
      ) : m.kind === 'audio' ? (
        <audio src={src} controls className="w-full px-3 py-2" onError={() => setFailed(true)} />
      ) : (
        <img src={src} alt={m.caption ?? ''} loading="lazy" className="max-h-[60dvh] w-full object-contain" onError={() => setFailed(true)} />
      )}
      {m.caption ? <figcaption className="border-t border-line px-3 py-1.5 text-[11px] leading-relaxed text-muted">{m.caption}</figcaption> : null}
      <div className="flex items-center gap-2 border-t border-line px-3 py-1 text-[10.5px] text-subtle">
        <span className="truncate" title={name}>
          {m.url ? '外部链接' : '待下载目录'} · {name}
        </span>
        <a href={src} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-accent hover:underline">
          打开
        </a>
      </div>
    </figure>
  );
}

function CallMedia({ media }) {
  const list = media ?? [];
  if (!list.length) return null;
  return (
    <div className="my-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {list.map((m, i) => (
        <MediaCard key={`${i}-${m.url ?? m.download}`} m={m} />
      ))}
    </div>
  );
}

/**
 * 用户消息气泡。插话（steer）**不在这里渲染**（见 ChatView 注释：由浅文字提示呈现）。
 */
export function SteerBubble({ msg }) {
  return (
    <div className="my-3 flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-line bg-raise px-3.5 py-2">
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[10.5px] text-subtle">
          {msg.steer ? <Badge tone="warn">插话</Badge> : null}
          <span>{fmtWhen(msg.ts)}</span>
        </div>
      </div>
    </div>
  );
}

function Message({ msg, streaming = false }) {
  const st = useApp();
  if (msg.role === 'user') return <SteerBubble msg={msg} />;

  const calls = Array.isArray(msg.calls) ? msg.calls : [];
  const notices = Array.isArray(msg.notices) ? msg.notices : [];
  /* 按"模型发出的顺序"分段：正文 → 该位置的媒体/文件卡 → 后续正文…
     （附件不再一律堆在整段文本之后；见 ui/lib/message-parts.js） */
  const parts = buildParts(msg.content, calls);
  const stats = statsLine(msg.stats);

  return (
    <div className="group/msg my-3">
      <div className="min-w-0">
        {notices.map((n, i) => (
          <p key={i} className="my-0.5 text-[11px] leading-relaxed whitespace-pre-wrap text-subtle">
            · {n}
          </p>
        ))}

        {msg.thinking || msg.thinkingChars || streaming ? <Thinking msg={msg} streaming={streaming} /> : null}
        {calls.length ? <TraceGroup calls={calls} runId={msg.runId} streaming={streaming} /> : null}
        {msg.error ? (
          <div className="my-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
            <p className="text-xs leading-relaxed whitespace-pre-wrap text-danger">{msg.error}</p>
          </div>
        ) : null}

        {parts.map((part, i) => (
          <div key={i}>
            {part.text.trim() ? (
              <div className="md text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }} />
            ) : null}
            <CallMedia media={part.calls.flatMap((c) => (Array.isArray(c.media) ? c.media : []))} />
            <CallFiles files={part.calls.flatMap((c) => (Array.isArray(c.files) ? c.files : []))} downloadsDir={st.downloadsDir} />
          </div>
        ))}
        {!msg.content && streaming ? (
          <p className="flex items-center gap-2 text-xs text-subtle">
            <Spinner className="size-3.5 text-accent" />
            正在生成…
          </p>
        ) : !msg.error && !calls.length && !notices.length ? (
          <p className="text-xs text-subtle">这一轮没有返回内容。</p>
        ) : null}

        {stats || calls.length ? (
          <p className="mt-1.5 text-[10.5px] tabular-nums text-subtle">
            {[stats, calls.length ? `操作 ${calls.length} 次` : ''].filter(Boolean).join(' · ')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default memo(Message);
