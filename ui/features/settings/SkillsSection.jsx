/**
 * ui/features/settings/SkillsSection.jsx —— 技能板块（需求 3）。
 *
 * 技能 = AI 工作的具体方法（SKILL.md：frontmatter 里 name/description，正文是步骤与坑）。
 * 系统提示词里只常驻目录（name + description），模型决定要用时 use_skill 载入全文——
 * 所以这里 description 写得准不准，直接决定模型会不会想到用它。
 * 支持按路径导入（目录或 .md 文件，服务端解析 frontmatter 后落到 data/skills/）。
 */
import { useEffect, useState } from 'react';
import { api } from '../../state/api.js';
import { askConfirm, toast } from '../../state/store.js';
import { Area, Badge, Btn, Field, Icon, Input, Section, Spinner, Toggle } from '../ui.jsx';
import { fmtWhen } from '../../lib/format.js';
import { PromptsList } from './PromptsSection.jsx';

const EMPTY = { name: '', description: '', body: '' };

export default function SkillsSection() {
  const [skills, setSkills] = useState(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null); // { name, description, body, editing }
  const [busy, setBusy] = useState(false);
  const [importPath, setImportPath] = useState('');

  const load = async () => {
    setErr('');
    try {
      const r = await api('/api/skills');
      setSkills(r.skills ?? []);
    } catch (e) {
      setErr(e?.message ?? String(e));
      setSkills([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openEdit = async (skill) => {
    setBusy(true);
    try {
      const r = await api(`/api/skills/${encodeURIComponent(skill.name)}`);
      setForm({ name: r.meta?.name ?? skill.name, description: r.meta?.description ?? '', body: r.body ?? '', editing: true });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!form.name.trim() || !form.body.trim()) return toast('name 与 body 必填', 'error');
    setBusy(true);
    try {
      await api('/api/skills', { method: 'POST', body: { name: form.name.trim(), description: form.description, body: form.body } });
      toast('技能已保存（下一轮目录里就能看到）', 'ok');
      setForm(null);
      await load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (skill) => {
    if (!askConfirm(`删除技能「${skill.name}」？目录会整份删掉。`)) return;
    try {
      await api(`/api/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      await load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const toggle = async (skill) => {
    try {
      const r = await api(`/api/skills/${encodeURIComponent(skill.name)}`, { method: 'POST', body: { enabled: !skill.enabled } });
      setSkills(r.skills ?? []);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const doImport = async () => {
    if (!importPath.trim()) return;
    setBusy(true);
    try {
      const r = await api('/api/skills/import', { method: 'POST', body: { path: importPath.trim() } });
      toast(`已导入 ${(r.imported ?? []).length} 个技能`, 'ok');
      setImportPath('');
      await load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="技能"
        desc="技能正文是 SKILL.md（frontmatter + 步骤）。目录常驻提示词，模型按需载入全文。"
        actions={
          <Btn size="sm" variant="primary" onClick={() => setForm({ ...EMPTY, editing: false })}>
            <Icon name="plus" className="size-3" />
            新建技能
          </Btn>
        }
      >
        <div className="flex flex-wrap items-end gap-2">
          <Field label="按路径导入（目录或 .md 文件）" className="min-w-48 flex-1">
            <Input value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="/path/to/skill 或 /path/to/SKILL.md" />
          </Field>
          <Btn size="sm" disabled={busy || !importPath.trim()} onClick={() => void doImport()}>
            {busy ? <Spinner className="size-3" /> : <Icon name="upload" className="size-3" />}
            导入
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => void load()}>
            <Icon name="refresh" className="size-3" />
            刷新
          </Btn>
        </div>

        {form ? (
          <div className="mt-2 rounded-lg border border-accent/30 bg-panel/60 p-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="name（小写字母数字与 -，唯一）">
                <Input value={form.name} disabled={form.editing} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="pdf-split" />
              </Field>
              <Field label="description（什么时候用这个技能——模型靠它决定要不要载入）">
                <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              </Field>
            </div>
            <Field label="正文（Markdown：步骤、命令、坑、验证方式）" className="mt-2">
              <Area value={form.body} rows={12} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
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

        {err ? <p className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{err}</p> : null}
        {skills && !skills.length ? <p className="mt-3 text-xs text-subtle">还没有技能。</p> : null}
        <ul className="mt-2 flex flex-col gap-1">
          {(skills ?? []).map((s) => (
            <li key={s.name} className="flex items-start gap-2 rounded-lg border border-line/60 bg-panel/30 px-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <button type="button" className="truncate text-left text-xs font-medium text-fg hover:text-accent" onClick={() => void openEdit(s)}>
                    {s.name}
                  </button>
                  {s.enabled === false ? <Badge tone="warn">已停用</Badge> : null}
                  {s.files?.length ? <Badge>{s.files.length} 个附件</Badge> : null}
                  <span className="text-[10px] text-subtle">{fmtWhen(s.updated)}</span>
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-subtle">{s.description || '（没有 description，模型很可能不会用它）'}</span>
              </span>
              <Btn size="sm" variant="ghost" onClick={() => void openEdit(s)} title="查看/编辑全文">
                <Icon name="edit" className="size-3" />
              </Btn>
              <Toggle checked={s.enabled !== false} onChange={() => void toggle(s)} title={s.enabled === false ? '启用' : '停用'} />
              <Btn size="sm" variant="ghost" onClick={() => void remove(s)} title="删除">
                <Icon name="trash" className="size-3 text-danger" />
              </Btn>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="技能模块提示词" desc="use_skill 的用法与返回格式（group=skills）。">
        <PromptsList groups={['skills']} />
      </Section>
    </div>
  );
}
