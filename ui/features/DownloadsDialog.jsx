/**
 * ui/features/DownloadsDialog.jsx —— 顶栏「待下载」：模型交付/抓取的文件。
 *
 * 列表来自 GET /api/downloads；图片/视频/音频用 /api/downloads/file?name=..&inline=1 内联预览
 * （<img>/<video> 带不了自定义头，令牌走 query，见 state/api.js 的 fileUrl），
 * 其它类型给下载链接（不带 inline=1 就是 attachment）。
 */
import { useEffect, useState } from 'react';
import { api, fileUrl } from '../state/api.js';
import { closeDownloads } from '../state/session.js';
import { baseName, fileKind, fmtBytes, fmtWhen } from '../lib/format.js';
import { Btn, Icon, Modal, Spinner } from './ui.jsx';

export default function DownloadsDialog() {
  const [files, setFiles] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('/api/downloads');
      setFiles(r.files ?? []);
    } catch (e) {
      setErr(e?.message ?? String(e));
      setFiles([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <Modal
      title="待下载"
      wide
      onClose={closeDownloads}
      footer={
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[11px] text-subtle">产物目录：data/downloads（ComfyUI 出图、抓取的文件都落这里）</span>
          <Btn size="sm" onClick={() => void load()} disabled={busy}>
            {busy ? <Spinner className="size-3.5" /> : <Icon name="refresh" className="size-3.5" />}
            刷新
          </Btn>
        </div>
      }
    >
      {err ? <p className="mb-2 rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{err}</p> : null}
      {!files ? (
        <p className="flex items-center gap-2 py-6 text-xs text-subtle">
          <Spinner className="size-3.5" />
          正在读目录…
        </p>
      ) : null}
      {files && !files.length ? <p className="py-8 text-center text-xs text-subtle">这个目录还是空的。</p> : null}
      {files?.length ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {files.map((f) => {
            const name = baseName(f.name);
            const kind = fileKind(name);
            const inline = fileUrl(name, true);
            const dl = fileUrl(name, false);
            return (
              <div key={f.name} className="overflow-hidden rounded-xl border border-line bg-panel/60">
                {kind === 'image' ? (
                  <a href={inline} target="_blank" rel="noreferrer noopener" title="点开原图">
                    <img src={inline} alt={name} loading="lazy" className="h-40 w-full bg-black/30 object-contain" />
                  </a>
                ) : null}
                {kind === 'video' ? <video src={inline} controls preload="metadata" className="h-40 w-full bg-black/40" /> : null}
                {kind === 'audio' ? <audio src={inline} controls preload="metadata" className="w-full px-2 pt-2" /> : null}
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <Icon name={kind === 'image' ? 'image' : kind === 'video' ? 'play' : 'file'} className="size-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={f.name}>
                    {name}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-subtle">
                    {fmtBytes(f.size)} · {fmtWhen(f.mtime)}
                  </span>
                  <a href={dl} download className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-accent hover:bg-accent/10" title="下载">
                    <Icon name="download" className="size-3" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </Modal>
  );
}
