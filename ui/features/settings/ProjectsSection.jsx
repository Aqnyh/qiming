/**
 * ui/features/settings/ProjectsSection.jsx —— 项目（需求 3，从「模型与参数」里独立出来）。
 *
 * 规则：**一切项目都在工作区之下**。工作区是这台机器上放项目的根目录（默认
 * /media/leo/DATA/workspace），目录选择器只在工作区内浏览、不允许往上越界，
 * 服务端也会再校验一遍（前端限制只是体验，真正的边界在服务端）。
 *
 * 每个项目三件事：名字（显示用）、路径（会话的默认工作目录，也是命令的 cwd）、
 * 以及"是否新会话的默认项目"。
 */
import { useEffect, useState } from 'react';
import { api } from '../../state/api.js';
import { useApp, patch, askConfirm, toast } from '../../state/store.js';
import { refreshProjects, setCurrentProject } from '../../state/session.js';
import { Badge, Btn, Field, Icon, Input, Modal, Section, Spinner } from '../ui.jsx';
import { MemoryBlock } from './MemorySection.jsx';

/** 工作区内的目录浏览（返回的 parent 到工作区根就是 null，所以天然点不出去） */
function DirPicker({ workspace, onPick, onClose }) {
  const [dir, setDir] = useState(null);
  const [err, setErr] = useState('');

  const go = async (p) => {
    setErr('');
    try {
      setDir(await api(`/api/browse?path=${encodeURIComponent(p)}`));
    } catch (e) {
      setErr(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    void go(workspace);
  }, [workspace]);

  return (
    <div className="mt-2 rounded-lg border border-line bg-panel/50 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Btn size="sm" onClick={() => dir?.parent && void go(dir.parent)} disabled={!dir?.parent} title={dir?.parent ? '上一层' : '已在工作区根'}>
          <Icon name="up" className="size-3" />
          上一层
        </Btn>
        <Btn size="sm" onClick={() => dir && void go(workspace)} title="回到工作区根">
          工作区根
        </Btn>
        <span className="flex-1" />
        <Btn size="sm" onClick={onClose}>
          收起
        </Btn>
      </div>
      <p className="mt-1.5 truncate font-mono text-[11px] text-muted" title={dir?.path}>
        {dir?.path ?? '读取中…'}
      </p>
      {err ? <p className="mt-1 text-[11px] text-danger">{err}</p> : null}
      <div className="thin-scroll mt-1 max-h-52 overflow-y-auto">
        {(dir?.items ?? []).map((it) => (
          <button
            key={it.name}
            type="button"
            onClick={() => void go(`${dir.path.replace(/\/$/, '')}/${it.name}`)}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-raise"
          >
            <Icon name="folder" className="size-3 shrink-0 text-subtle" />
            <span className="truncate">{it.name}</span>
          </button>
        ))}
        {dir && !dir.items.length ? <p className="px-1.5 py-2 text-[11px] text-subtle">（下面没有子目录）</p> : null}
      </div>
      {dir ? (
        <Btn size="sm" variant="primary" className="mt-2" onClick={() => onPick(dir.path)}>
          用这个目录建项目
        </Btn>
      ) : null}
    </div>
  );
}

export default function ProjectsSection() {
  const st = useApp();
  const [workspace, setWorkspace] = useState('');
  const [draftWs, setDraftWs] = useState('');
  const [newName, setNewName] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [editing, setEditing] = useState(null); // { id, name, root }
  const [memOpen, setMemOpen] = useState(''); // 展开记忆的项目 id（一次只开一个，列表不被撑爆）
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setWorkspace(st.projectsWorkspace ?? '');
    setDraftWs(st.projectsWorkspace ?? '');
  }, [st.projectsWorkspace]);

  const saveWorkspace = async () => {
    setBusy(true);
    try {
      const r = await api('/api/settings', { method: 'POST', body: { workspace: draftWs.trim() } });
      patch({ settings: r, projectsWorkspace: r.workspace });
      setWorkspace(r.workspace);
      setDraftWs(r.workspace);
      toast('工作区已更新', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addProject = async (root) => {
    if (!root?.trim()) return;
    try {
      await api('/api/projects', { method: 'POST', body: { root: root.trim(), name: newName.trim() || undefined } });
      setNewName('');
      setShowBrowser(false);
      toast('项目已创建', 'ok');
      await refreshProjects();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api(`/api/projects/${encodeURIComponent(editing.id)}`, {
        method: 'POST',
        body: { name: editing.name, root: editing.root },
      });
      setEditing(null);
      toast('项目已更新', 'ok');
      await refreshProjects();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const removeProject = async (p) => {
    if (!askConfirm(`移除项目「${p.name}」？（只从列表移除，磁盘文件与项目记忆都保留）`)) return;
    try {
      await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      await refreshProjects();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="工作区"
        desc="放项目的地方。所有项目都必须在这个目录之下（目录选择器与接口都会拦），改它不会搬动已有文件。"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field label="工作区根目录" className="min-w-[16rem] flex-1">
            <Input value={draftWs} onChange={(e) => setDraftWs(e.target.value)} placeholder="/media/leo/DATA/workspace" />
          </Field>
          <Btn size="sm" variant="primary" disabled={busy || !draftWs.trim() || draftWs.trim() === workspace} onClick={() => void saveWorkspace()}>
            {busy ? <Spinner className="size-3" /> : null}
            保存
          </Btn>
        </div>
        <p className="mt-1 text-[11px] text-subtle">
          当前：<span className="font-mono">{workspace || '（未设置）'}</span>
        </p>
      </Section>

      <Section
        title="项目"
        desc="项目 = 一个目录。会话归属项目后，命令以它为工作目录跑；每个项目的记忆可以在这里直接展开读写（与「记忆」页汇总的是同一份）。"
        actions={
          <Btn size="sm" onClick={() => setShowBrowser((v) => !v)}>
            <Icon name="plus" className="size-3" />
            新建项目
          </Btn>
        }
      >
        {showBrowser ? (
          <>
            <Field label="项目名（可留空，用目录名）" className="max-w-xs">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例如：启明 / 抖音热点" />
            </Field>
            <DirPicker workspace={workspace} onPick={(p) => void addProject(p)} onClose={() => setShowBrowser(false)} />
          </>
        ) : null}

        <div className="mt-2 flex flex-col gap-1.5">
          {(st.projects ?? []).map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line/60 bg-panel/40 px-2.5 py-2">
              <Icon name="folder" className={`size-3.5 shrink-0 ${p.id === st.currentProjectId ? 'text-accent' : 'text-subtle'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs">{p.name}</span>
                  {p.id === st.currentProjectId ? <Badge tone="accent">新会话默认</Badge> : null}
                </div>
                <p className="truncate font-mono text-[10.5px] text-subtle" title={p.root}>
                  {p.root}
                </p>
              </div>
              {p.id !== st.currentProjectId ? (
                <Btn size="sm" onClick={() => setCurrentProject(p.id)}>
                  设为默认
                </Btn>
              ) : null}
              <Btn
                size="sm"
                variant={memOpen === p.id ? 'primary' : 'outline'}
                onClick={() => setMemOpen((cur) => (cur === p.id ? '' : p.id))}
                title="展开读写这个项目的记忆（与「记忆」页是同一份）"
              >
                <Icon name="brain" className="size-3" />
                项目记忆
              </Btn>
              <Btn size="sm" onClick={() => setEditing({ id: p.id, name: p.name, root: p.root })}>
                <Icon name="edit" className="size-3" />
                修改
              </Btn>
              <Btn size="sm" variant="danger" onClick={() => void removeProject(p)} title="只从列表移除">
                <Icon name="trash" className="size-3" />
              </Btn>
              {memOpen === p.id ? (
                <div className="mt-1 w-full">
                  <MemoryBlock
                    scope="project"
                    projectId={p.id}
                    label={`${p.name} · 项目记忆`}
                    hint="只属于这个项目的记录；「记忆」页里也有同一块（同一份数据）"
                    defaultOpen
                  />
                </div>
              ) : null}
            </div>
          ))}
          {!st.projects?.length ? (
            <p className="py-2 text-xs text-subtle">还没有项目。点「新建项目」在工作区里挑一个目录。</p>
          ) : null}
        </div>
      </Section>

      {editing ? (
        <Modal
          title="修改项目"
          onClose={() => setEditing(null)}
          footer={
            <>
              <Btn size="sm" onClick={() => setEditing(null)}>
                取消
              </Btn>
              <Btn size="sm" variant="primary" onClick={() => void saveEdit()}>
                保存
              </Btn>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Field label="项目名">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="路径" hint="必须在工作区之内；改路径不会移动磁盘上的文件">
              <Input value={editing.root} onChange={(e) => setEditing({ ...editing, root: e.target.value })} />
            </Field>
            <p className="text-[11px] text-subtle">
              工作区：<span className="font-mono">{workspace}</span>
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
