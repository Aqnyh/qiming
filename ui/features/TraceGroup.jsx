/**
 * ui/features/TraceGroup.jsx —— 一条助手消息里的操作折叠组（需求 5 的"操作计数折叠显示"）。
 *
 *  折叠时只有一行：`操作 N 步` + 失败数 + 改动处数/行数 + 累计耗时；
 *  **默认收起**（用户要的是"先看结论"）；每条调用的完整参数与结果**点击时才**从
 *  `GET /api/run/{runId}/call/{seq}` 取回 —— 事件流里只有摘要（argsDigest/digest/chars），
 *  全文一直留在服务端（内存纪律，见 ARCHITECTURE.md 第三节）。
 *  取回的结果按 (runId,seq) 缓存：反复开合不再重复请求（一次运行内 seq 唯一）。
 *  交付的文件**不在这里**：它们画在折叠组外面（见 Message.jsx），收起也看得见。
 */
import { memo, useState } from 'react';
import { api } from '../state/api.js';
import { Badge, Icon, Spinner } from './ui.jsx';
import { fmtChars, fmtCount, fmtDuration } from '../lib/format.js';

/** 详情缓存：`runId:seq` → 详情（同一条反复开合不再请求） */
const cache = new Map();
const inflight = new Map();

function loadDetail(runId, seq) {
  const key = `${runId}:${seq}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (!inflight.has(key)) {
    inflight.set(
      key,
      api(`/api/run/${encodeURIComponent(runId)}/call/${seq}`)
        .then((d) => {
          cache.set(key, d);
          return d;
        })
        .finally(() => inflight.delete(key)),
    );
  }
  return inflight.get(key);
}

function StateMark({ state }) {
  if (state === 'running') return <Spinner className="size-3.5 shrink-0 text-accent" />;
  if (state === 'fail') return <Icon name="close" className="size-3.5 shrink-0 text-danger" />;
  return <Icon name="check" className="size-3.5 shrink-0 text-ok" />;
}

/** 单条调用：一行摘要；点击展开时取完整参数与结果 */
function CallRow({ call, runId }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail || loading || !runId) return;
    setLoading(true);
    setErr('');
    try {
      setDetail(await loadDetail(runId, call.seq));
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-line/70 bg-panel/40">
      <button type="button" onClick={toggle} title={open ? '收起这条调用' : '展开看完整参数与结果'} className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 text-left hover:bg-raise/50">
        <Icon name="chevron" className={`size-3 shrink-0 text-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
        <StateMark state={call.state} />
        <span className="shrink-0 font-mono text-[11px] text-fg">{call.name}</span>
        {call.label && call.label !== call.name ? <span className="min-w-0 truncate text-[11px] text-muted">{call.label}</span> : null}
        {call.argsDigest ? <span className="min-w-0 max-w-[45%] truncate font-mono text-[10.5px] text-subtle" title={call.argsDigest}>{call.argsDigest}</span> : null}
        <span className="flex-1" />
        {call.lines ? (
          <span className="shrink-0 tabular-nums text-[10.5px]">
            <span className="text-ok">+{fmtCount(call.lines.added)}</span> <span className="text-danger">−{fmtCount(call.lines.removed)}</span>
          </span>
        ) : null}
        {call.chars ? <span className="shrink-0 text-[10.5px] tabular-nums text-subtle">{fmtChars(call.chars)}</span> : null}
        {call.errorCode ? <span className="shrink-0 rounded border border-danger/40 px-1 text-[10px] font-mono text-danger" title="标准错误码（按它分类，不靠文案猜）">{call.errorCode}</span> : null}
        {call.spill ? (
          <span className="shrink-0 text-[10.5px] tabular-nums text-accent" title={`全文已落盘：${call.spill.path}`}>
            全文落盘 {fmtChars(call.spill.chars)}
          </span>
        ) : null}
        {call.ms ? <span className="shrink-0 text-[10.5px] tabular-nums text-subtle">{fmtDuration(call.ms)}</span> : null}
        {call.subRunId ? <Badge tone="accent">子智能体</Badge> : null}
      </button>
      {open ? (
        <div className="border-t border-line/60 px-2 py-2">
          {!runId ? <p className="text-[11px] text-subtle">这条调用没有运行 id（旧数据），取不到详情。</p> : null}
          {loading ? (
            <p className="flex items-center gap-1.5 text-[11px] text-subtle">
              <Spinner className="size-3" />
              正在取完整记录…
            </p>
          ) : null}
          {err ? <p className="text-[11px] text-danger">{err}</p> : null}
          {detail ? (
            <div className="flex flex-col gap-2">
              <div>
                <p className="mb-1 text-[10.5px] text-subtle">参数（{detail.pluginId} · {detail.ms ? fmtDuration(detail.ms) : '进行中'}）</p>
                <pre className="thin-scroll max-h-64 overflow-auto rounded-md border border-line/60 bg-bg/70 p-2 font-mono text-[11px] leading-relaxed">{JSON.stringify(detail.args ?? {}, null, 2)}</pre>
              </div>
              <div>
                <p className="mb-1 text-[10.5px] text-subtle">{detail.ok ? '结果' : '结果（失败）'}</p>
                <pre className={`thin-scroll max-h-80 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap ${detail.ok ? 'border-line/60 bg-bg/70' : 'border-danger/40 bg-danger/5 text-danger'}`}>
                  {detail.text || '（没有输出）'}
                </pre>
              </div>
              {call.spill ? (
                <div>
                  <p className="mb-1 text-[10.5px] text-subtle">完整结果已落盘（回灌给模型的是头尾预览）</p>
                  <div className="flex items-center gap-1.5 rounded-md border border-line/60 bg-bg/70 px-2 py-1.5">
                    <Icon name="file" className="size-3.5 shrink-0 text-muted" />
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={call.spill.path}>
                      {call.spill.path}
                    </code>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-subtle">{fmtChars(call.spill.chars)}</span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TraceGroup({ calls, runId, streaming = false }) {
  const [open, setOpen] = useState(false); // 需求：默认收起
  const list = Array.isArray(calls) ? calls : [];
  if (!list.length) return null;

  const failed = list.filter((c) => c.state === 'fail').length;
  const running = list.filter((c) => c.state === 'running').length;
  const changedFiles = list.filter((c) => c.lines).length;
  const added = list.reduce((n, c) => n + (c.lines?.added ?? 0), 0);
  const removed = list.reduce((n, c) => n + (c.lines?.removed ?? 0), 0);
  const ms = list.reduce((n, c) => n + (c.ms ?? 0), 0);

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起这些操作，只看结论' : '展开看每一步的参数与结果'}
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-line/70 bg-panel/40 px-2 py-1 text-left hover:bg-raise/50"
      >
        <Icon name="chevron" className={`size-3 shrink-0 text-subtle transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="grid size-4 shrink-0 place-items-center rounded border border-line bg-muted/40 text-muted">
          {streaming && running ? <Spinner className="size-3 text-accent" /> : <Icon name="terminal" className="size-3" />}
        </span>
        <span className={streaming ? 'shrink-0 text-xs text-fg shimmer' : 'shrink-0 text-xs text-fg'}>
          {streaming && running ? `正在执行 ${list.length} 步操作…` : `操作 ${list.length} 步`}
        </span>
        {failed ? <span className="shrink-0 text-[11px] font-medium text-danger">✕ {failed} 步失败</span> : null}
        {changedFiles ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted" title={`${changedFiles} 处文件改动：写入 ${added} 行、删除 ${removed} 行`}>
            ✎ {changedFiles} 处改动 <span className="text-ok">+{fmtCount(added)}</span> <span className="text-danger">−{fmtCount(removed)}</span>
          </span>
        ) : null}
        <span className="flex-1" />
        {ms ? <span className="shrink-0 text-[10.5px] tabular-nums text-subtle">累计 {fmtDuration(ms)}</span> : null}
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1 border-l-2 border-line/60 pl-2">
          {list.map((c) => (
            <CallRow key={c.seq} call={c} runId={runId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default memo(TraceGroup);
