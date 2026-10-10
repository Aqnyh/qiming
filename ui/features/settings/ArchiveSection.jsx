/**
 * ui/features/settings/ArchiveSection.jsx —— 归档（需求 6）。
 *
 * 归档不是删除：会话/项目从侧栏移走，记录、消息、项目记忆都还在，
 * 在这里可以**恢复**或**彻底删除**。两条纪律：
 *  · 彻底删除**只在这个页面可用**（侧栏只能归档）—— 防手滑，也防"想整理一下结果删没了"；
 *  · 删项目会连带它的会话记录与**项目记忆目录**，但**磁盘上的项目文件一个字都不动**
 *    （那是用户的代码/文档，不属于本工程管）。
 */
import { useEffect, useState } from 'react';
import { askConfirm, toast } from '../../state/store.js';
import { purgeProject, purgeSession, refreshArchive, refreshSessions } from '../../state/session.js';
import { api } from '../../state/api.js';
import { Badge, Btn, Icon, Section, Spinner } from '../ui.jsx';
import { fmtWhen } from '../../lib/format.js';

export default function ArchiveSection() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    setErr('');
    try {
      setData(await refreshArchive());
    } catch (e) {
      setErr(e?.message ?? String(e));
      setData({ sessions: [], projects: [] });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const restoreSession = async (s) => {
    setBusy(s.id);
    try {
      await api(`/api/session/${encodeURIComponent(s.id)}/archive`, { method: 'POST', body: { archived: false } });
      await refreshSessions();
      await load();
      toast('会话已恢复', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const dropSession = async (s) => {
    if (!askConfirm(`彻底删除会话「${s.title || s.id}」？消息记录会被删掉，**不可恢复**。`)) return;
    setBusy(s.id);
    try {
      await purgeSession(s.id);
      await load();
      toast('会话已彻底删除', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const restoreProject = async (p) => {
    setBusy(p.id);
    try {
      await api(`/api/projects/${encodeURIComponent(p.id)}/archive`, { method: 'POST', body: { archived: false } });
      await load();
      toast('项目与它的会话已恢复', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const dropProject = async (p) => {
    if (!askConfirm(`彻底删除项目「${p.name}」？会一并删掉它的会话记录与**项目记忆**（${p.root} 里的文件不动），不可恢复。`)) return;
    setBusy(p.id);
    try {
      await purgeProject(p.id);
      await load();
      toast('项目已彻底删除', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const sessions = data?.sessions ?? [];
  const projects = data?.projects ?? [];

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="归档"
        desc="侧栏只能「归档」——归档的东西都在这儿：可以恢复，也可以彻底删除。彻底删除不可撤销（项目会连带删掉它的会话记录与项目记忆，磁盘上的项目文件不动）。"
        actions={
          <Btn size="sm" onClick={() => void load()}>
            <Icon name="refresh" className="size-3" />
            刷新
          </Btn>
        }
      >
        {err ? <p className="rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{err}</p> : null}
        {!data ? (
          <p className="flex items-center gap-2 py-3 text-xs text-subtle">
            <Spinner className="size-3.5" />
            正在读归档…
          </p>
        ) : null}

        {data && !projects.length && !sessions.length ? (
          <p className="py-3 text-xs text-subtle">归档是空的。在侧栏把不用的会话/项目「归档」后，它们会出现在这里。</p>
        ) : null}

        {projects.length ? (
          <div className="mb-2">
            <h4 className="mb-1.5 text-xs font-medium text-muted">已归档的项目（{projects.length}）</h4>
            <div className="flex flex-col gap-1.5">
              {projects.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line/60 bg-panel/40 px-2.5 py-2">
                  <Icon name="folder" className="size-3.5 shrink-0 text-subtle" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs">{p.name}</span>
                      <Badge>归档于 {fmtWhen(p.archivedAt)}</Badge>
                    </div>
                    <p className="truncate font-mono text-[10.5px] text-subtle" title={p.root}>
                      {p.root}
                    </p>
                  </div>
                  <Btn size="sm" disabled={busy === p.id} onClick={() => void restoreProject(p)}>
                    <Icon name="refresh" className="size-3" />
                    恢复
                  </Btn>
                  <Btn size="sm" variant="danger" disabled={busy === p.id} onClick={() => void dropProject(p)}>
                    <Icon name="trash" className="size-3" />
                    彻底删除
                  </Btn>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {sessions.length ? (
          <div>
            <h4 className="mb-1.5 text-xs font-medium text-muted">已归档的会话（{sessions.length}）</h4>
            <div className="flex flex-col gap-1.5">
              {sessions.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line/60 bg-panel/40 px-2.5 py-2">
                  <Icon name="file" className="size-3.5 shrink-0 text-subtle" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs">{s.title || '新会话'}</span>
                      <Badge>归档于 {fmtWhen(s.archivedAt)}</Badge>
                      <span className="text-[10.5px] text-subtle">{s.count} 条消息</span>
                    </div>
                    {s.last ? <p className="truncate text-[10.5px] text-subtle">{s.last}</p> : null}
                  </div>
                  <Btn size="sm" disabled={busy === s.id} onClick={() => void restoreSession(s)}>
                    <Icon name="refresh" className="size-3" />
                    恢复
                  </Btn>
                  <Btn size="sm" variant="danger" disabled={busy === s.id} onClick={() => void dropSession(s)}>
                    <Icon name="trash" className="size-3" />
                    彻底删除
                  </Btn>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
