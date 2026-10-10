/**
 * ui/features/settings/MemorySection.jsx —— 记忆板块：**全部记忆的汇总**（需求 1）。
 *
 * 归一化（本页与「项目」页的关系）：
 *   记忆只有两种作用域（全局 / 某个项目），存储就是 `data/memory/` 与 `data/projects/<id>/memory/` 的
 *   Markdown 文件 —— 不管从哪进、从哪改，读写的都是**同一份**。
 *   本页把它们**按作用域折叠展开**汇总在一起；「项目」页每个项目下面也有一个折叠块，
 *   用的是同一个 `MemoryBlock` 组件、同一组接口（`/api/memory`），所以两边永远一致。
 *
 * 列表接口只回索引（title/description/tags，正文置空），**看全文**或**编辑**时才按
 * `/api/memory/entry` 取正文——与会话列表同一套"列表轻、详情按需"的纪律。
 * 删除是服务端软删除（进 .trash/），这里仍要确认一次，避免误点。
 */
import { useEffect, useState } from 'react';
import { api } from '../../state/api.js';
import { useApp, askConfirm, toast } from '../../state/store.js';
import { Area, Badge, Btn, Field, Icon, Input, Modal, Section, Spinner } from '../ui.jsx';
import { fmtWhen } from '../../lib/format.js';
import { PromptsList } from './PromptsSection.jsx';

const scopeQuery = (scope, projectId) => (scope === 'global' ? 'scope=global' : `scope=project&projectId=${encodeURIComponent(projectId)}`);

const EMPTY_FORM = { slug: '', title: '', description: '', tags: '', body: '' };

/** 查看全文：按需取正文（列表里没有 body） */
async function openView(entry, setView, scope, projectId) {
  try {
    const r = await api(`/api/memory/entry?${scopeQuery(scope, projectId)}&slug=${encodeURIComponent(entry.slug)}`);
    setView(r.entry ?? r);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/**
 * 一个作用域的记忆块（全局或某个项目）：折叠标题 + 计数，展开后读写。
 * 懒加载：展开时才拉条目 —— 汇总页有 N 个项目，不该一进来就发 N 个请求。
 *
 * @param scope       'global' | 'project'
 * @param projectId   项目作用域必填
 * @param label       标题（项目名 / "全局记忆"）
 * @param hint        标题下的一行小字
 * @param defaultOpen 默认是否展开
 */
export function MemoryBlock({ scope, projectId, label, hint = '', defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null);
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);

  const ready = scope === 'global' || Boolean(projectId);

  const load = async () => {
    setErr('');
    if (!ready) {
      setEntries([]);
      return;
    }
    try {
      const r = await api(`/api/memory?${scopeQuery(scope, projectId)}`);
      setEntries(r.entries ?? []);
    } catch (e) {
      setErr(e?.message ?? String(e));
      setEntries([]);
    }
  };

  useEffect(() => {
    if (open && entries === null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async () => {
    if (!form.title.trim() || !form.body.trim()) return toast('title 与 body 必填', 'error');
    setBusy(true);
    try {
      await api('/api/memory', {
        method: 'POST',
        body: {
          scope,
          ...(scope === 'project' ? { projectId } : {}),
          slug: form.slug.trim() || undefined,
          title: form.title.trim(),
          description: form.description.trim(),
          body: form.body,
          tags: form.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        },
      });
      toast('已保存', 'ok');
      setForm(null);
      await load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry) => {
    if (!askConfirm(`删除记忆「${entry.title}」？（服务端会先移到 .trash/，但界面上不再可见）`)) return;
    try {
      await api(`/api/memory?${scopeQuery(scope, projectId)}&slug=${encodeURIComponent(entry.slug)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      await load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const openEdit = async (entry) => {
    setBusy(true);
    try {
      const r = await api(`/api/memory/entry?${scopeQuery(scope, projectId)}&slug=${encodeURIComponent(entry.slug)}`);
      const e = r.entry ?? r;
      setForm({
        slug: e.slug ?? entry.slug,
        title: e.title ?? '',
        description: e.description ?? '',
        tags: (e.tags ?? []).join(', '),
        body: e.body ?? '',
      });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line/70 bg-panel/30">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <Icon name={open ? 'chevron-down' : 'chevron'} className="size-3.5 shrink-0 text-subtle" />
          <Icon name={scope === 'global' ? 'brain' : 'folder'} className="size-3.5 shrink-0 text-accent" />
          <span className="min-w-0 truncate text-xs font-medium">{label}</span>
          {entries ? <span className="shrink-0 text-[10.5px] tabular-nums text-subtle">{entries.length} 条</span> : null}
        </button>
        {open ? (
          <>
            <Btn size="sm" variant="ghost" onClick={() => void load()} title="刷新">
              <Icon name="refresh" className="size-3" />
            </Btn>
            <Btn size="sm" onClick={() => setForm({ ...EMPTY_FORM })} disabled={!ready}>
              <Icon name="plus" className="size-3" />
              新建
            </Btn>
          </>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-line/60 px-2 py-2">
          {hint ? <p className="mb-1.5 text-[10.5px] text-subtle">{hint}</p> : null}
          {!ready ? <p className="text-xs text-warn">这个项目还没有 id（先保存一次项目）。</p> : null}
          {err ? <p className="rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{err}</p> : null}
          {entries === null ? (
            <p className="flex items-center gap-2 py-2 text-xs text-subtle">
              <Spinner className="size-3.5" />
              正在读记忆…
            </p>
          ) : null}

          {form ? (
            <div className="mb-2 rounded-lg border border-accent/30 bg-panel/60 p-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="标题" hint={form.slug ? '编辑已有条目：文件名（slug）不变' : '新建时可留空 slug，由标题生成'}>
                  <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
                </Field>
                <Field label="slug（文件名，可留空）">
                  <Input value={form.slug} disabled={Boolean(form.slug)} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} />
                </Field>
              </div>
              <Field label="一句话摘要" className="mt-2">
                <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              </Field>
              <Field label="标签（逗号分隔）" className="mt-2">
                <Input value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} />
              </Field>
              <Field label="正文（Markdown）" className="mt-2">
                <Area value={form.body} rows={8} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
              </Field>
              <div className="mt-2 flex justify-end gap-2">
                <Btn size="sm" onClick={() => setForm(null)}>
                  取消
                </Btn>
                <Btn size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                  {busy ? <Spinner className="size-3" /> : null}
                  保存
                </Btn>
              </div>
            </div>
          ) : null}

          {entries && !entries.length && !form ? (
            <p className="py-1.5 text-xs text-subtle">
              {scope === 'global' ? '还没有全局记忆。' : '这个项目还没有专属记忆。'}
            </p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {(entries ?? []).map((e) => (
              <li key={e.slug} className="flex items-start gap-2 rounded-lg border border-line/60 bg-panel/40 px-2 py-1.5">
                <span className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="block max-w-full truncate text-left text-xs font-medium text-fg hover:text-accent"
                    onClick={() => void openView(e, setView, scope, projectId)}
                  >
                    {e.title}
                  </button>
                  <span className="mt-0.5 block truncate text-[11px] text-subtle">{e.description}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-subtle">
                    <span className="font-mono">{e.slug}</span>
                    {(e.tags ?? []).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                    <span>{fmtWhen(e.updated)}</span>
                  </span>
                </span>
                <Btn size="sm" variant="ghost" onClick={() => void openEdit(e)} title="编辑">
                  <Icon name="edit" className="size-3" />
                </Btn>
                <Btn size="sm" variant="ghost" onClick={() => void remove(e)} title="删除">
                  <Icon name="trash" className="size-3 text-danger" />
                </Btn>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view ? (
        <Modal title={view.title} wide onClose={() => setView(null)}>
          <p className="mb-2 text-[11px] text-subtle">
            {view.scopeLabel} · <span className="font-mono">{view.slug}</span> · 更新于 {fmtWhen(view.updated)}
          </p>
          {view.description ? <p className="mb-3 text-xs text-muted">{view.description}</p> : null}
          <pre className="thin-scroll max-h-[60dvh] overflow-auto rounded-lg border border-line bg-panel/40 p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap">{view.body}</pre>
        </Modal>
      ) : null}
    </div>
  );
}

export default function MemorySection() {
  const st = useApp();
  const [scopes, setScopes] = useState(null);

  const loadCounts = async () => {
    try {
      const r = await api('/api/memory?scope=all');
      setScopes(r.scopes ?? []);
    } catch {
      setScopes([]);
    }
  };

  useEffect(() => {
    void loadCounts();
  }, []);

  const global = scopes?.find((s) => s.kind === 'global');
  const projectScopes = (scopes ?? []).filter((s) => s.kind === 'project');

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="记忆（全部汇总）"
        desc="AI 工作的重要记录，按作用域折叠汇总：全局（本机通用）与每个项目各一块。索引常驻系统提示词，全文模型按需 memory_read。这里与「项目」页里那个折叠块改的是**同一份**（都是 data/ 下的 Markdown 文件）。"
        actions={
          <Btn size="sm" variant="ghost" onClick={() => void loadCounts()}>
            <Icon name="refresh" className="size-3" />
            刷新计数
          </Btn>
        }
      >
        {!scopes ? (
          <p className="flex items-center gap-2 py-3 text-xs text-subtle">
            <Spinner className="size-3.5" />
            正在读记忆索引…
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <MemoryBlock scope="global" label="全局记忆" hint="跨项目通用的事实（偏好、环境、账号、坑）" defaultOpen />
          {projectScopes.map((s) => (
            <MemoryBlock
              key={s.projectId}
              scope="project"
              projectId={s.projectId}
              label={s.label}
              hint={`只属于这个项目的记录（项目记忆）· 展开后可读写`}
            />
          ))}
          {scopes && !projectScopes.length ? (
            <p className="text-[11px] text-subtle">还没有项目 —— 到「设置 → 项目」建一个，它的项目记忆会出现在这里。</p>
          ) : null}
        </div>
      </Section>

      <Section title="记忆模块提示词" desc="索引/读写的用法说明（group=memory）。">
        <PromptsList groups={['memory']} />
      </Section>
    </div>
  );
}
