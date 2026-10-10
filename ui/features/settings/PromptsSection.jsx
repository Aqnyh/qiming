/**
 * ui/features/settings/PromptsSection.jsx —— 提示词板块：**全部提示词的汇总视图**（需求 2）。
 *
 * 数据归一化（本页的存在意义）：
 *   系统 / 循环 / 记忆 / 技能 / 压缩 / 插件用法与工具描述 / 外部资源说明与工具描述
 *   —— 全部条目都在**同一个注册中心**（服务端 prompts.json），本页是它们的统一入口。
 *   插件页改的用法说明、资源页改的说明、记忆页改的注入语，和这里改的是**同一条记录**：
 *   两边看到的内容一致、效果一致（改完下一轮生效）。行尾的「也能在 X 页改」就是这条对应关系。
 *
 * `PromptsList` 导出给记忆/技能/外部资源三个板块复用（它们只看自己那几组）。
 */
import { useEffect, useState } from 'react';
import { api } from '../../state/api.js';
import { toast } from '../../state/store.js';
import { Area, Badge, Btn, Field, Input, Section, Select, Spinner, Toggle } from '../ui.jsx';

const GROUP_NAMES = {
  system: '系统提示词（身份与规则）',
  loop: '循环过程文案（回灌给模型的话）',
  memory: '记忆模块',
  skills: '技能模块',
  compact: '上下文压缩',
  resources: '外部资源（总）',
};

export function groupLabel(g) {
  if (GROUP_NAMES[g]) return GROUP_NAMES[g];
  if (String(g).startsWith('plugin:')) return `插件：${g.slice('plugin:'.length)}`;
  if (String(g).startsWith('res:')) return `外部资源：${g.slice('res:'.length)}`;
  return g;
}

/**
 * 这条提示词在**别的**哪个页面也能改（数据归一化的可见证据）。
 * 同一个条目在不同页面里看到时，"另一个入口"是不同的 —— 所以在资源页/插件页里
 * 指的是「提示词」页，在提示词页里指的是对应模块页。
 */
function sourceHint(group, mode) {
  if (mode === 'module') return '提示词';
  const g = String(group);
  if (g.startsWith('plugin:')) return '插件页';
  if (g.startsWith('res:')) return '外部资源页';
  if (g === 'memory') return '记忆页';
  if (g === 'skills') return '技能页';
  return '';
}

/** 单条提示词：文本 + 启停 + 保存 + 恢复默认 */
function PromptRow({ entry, onChanged, hintMode = 'prompts' }) {
  const [text, setText] = useState(entry.text);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  // 服务端数据刷新时同步（用户正在改就不覆盖他的输入）
  useEffect(() => {
    if (!dirty) setText(entry.text);
  }, [entry.text, dirty]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/prompts/${encodeURIComponent(entry.id)}`, { method: 'POST', body: { text } });
      onChanged(r.entry);
      setDirty(false);
      toast('已保存，下一轮生效', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/prompts/${encodeURIComponent(entry.id)}/reset`, { method: 'POST', body: {} });
      onChanged(r.entry);
      setDirty(false);
      setText(r.entry.text);
      toast('已恢复默认', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    try {
      const r = await api(`/api/prompts/${encodeURIComponent(entry.id)}`, { method: 'POST', body: { enabled: !entry.enabled } });
      onChanged(r.entry);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const also = sourceHint(entry.group, hintMode);

  return (
    <div className="rounded-lg border border-line/70 bg-panel/40 p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-fg">{entry.name}</span>
        <span className="font-mono text-[10px] text-subtle">{entry.id}</span>
        {entry.changed ? <Badge tone="accent">已改</Badge> : null}
        {entry.enabled === false ? <Badge tone="warn">已停用</Badge> : null}
        {also ? <span className="text-[10px] text-subtle" title="两个入口改的是同一条记录">也能在「{also}」改</span> : null}
        <span className="flex-1" />
        {entry.toggleable ? <Toggle checked={entry.enabled !== false} onChange={toggle} title="启用/停用这条提示词" /> : null}
        {entry.changed ? (
          <Btn size="sm" onClick={() => void reset()} disabled={busy} title="恢复成代码里的默认文本">
            恢复默认
          </Btn>
        ) : null}
        <Btn size="sm" variant={dirty ? 'primary' : 'outline'} onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? <Spinner className="size-3" /> : null}
          保存
        </Btn>
      </div>
      <Area
        value={text}
        rows={Math.min(14, Math.max(3, text.split('\n').length))}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
      />
    </div>
  );
}

/** 一组提示词（自拉数据；groups 传 group 名数组表示只看这几组，不传 = 全部） */
export function PromptsList({ groups, heading = '', showFilter = false, hintMode = 'module' }) {
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState('');
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');

  const load = async () => {
    setErr('');
    try {
      const r = await api('/api/prompts');
      setEntries(r.prompts ?? []);
    } catch (e) {
      setErr(e?.message ?? String(e));
      setEntries([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const scoped = (entries ?? []).filter((e) => !groups || groups.includes(e.group));
  if (err) return <p className="rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{err}</p>;
  if (!entries) {
    return (
      <p className="flex items-center gap-2 py-3 text-xs text-subtle">
        <Spinner className="size-3.5" />
        正在读提示词…
      </p>
    );
  }

  const allGroups = [...new Set(scoped.map((e) => e.group))];
  const needle = q.trim().toLowerCase();
  const list = scoped
    .filter((e) => !group || e.group === group)
    .filter((e) => !needle || e.id.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle) || e.text.toLowerCase().includes(needle));

  // 按 group 分组展示（服务端顺序稳定：核心 → 循环 → 各模块 → 插件/资源）
  const byGroup = new Map();
  for (const e of list) {
    if (!byGroup.has(e.group)) byGroup.set(e.group, []);
    byGroup.get(e.group).push(e);
  }

  return (
    <div className="flex flex-col gap-3">
      {heading ? <p className="text-[11px] text-subtle">{heading}</p> : null}
      {showFilter ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="只看某一组" className="w-56">
            <Select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">全部（{scoped.length} 条）</option>
              {allGroups.map((g) => (
                <option key={g} value={g}>
                  {groupLabel(g)}（{scoped.filter((e) => e.group === g).length}）
                </option>
              ))}
            </Select>
          </Field>
          <Field label="搜索（id / 名字 / 正文）" className="min-w-48 flex-1">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="例如 fs、记忆、system.base" />
          </Field>
          {group || q ? (
            <Btn
              size="sm"
              onClick={() => {
                setGroup('');
                setQ('');
              }}
            >
              清空
            </Btn>
          ) : null}
        </div>
      ) : null}
      {!list.length ? <p className="py-3 text-xs text-subtle">没有匹配的条目。</p> : null}
      {[...byGroup.entries()].map(([g, items]) => (
        <div key={g}>
          <div className="mb-1.5 flex items-center gap-2">
            <h4 className="text-xs font-medium text-muted">{groupLabel(g)}</h4>
            <span className="text-[10px] text-subtle">{items.length} 条</span>
          </div>
          <div className="flex flex-col gap-2">
            {items.map((e) => (
              <PromptRow
                key={e.id}
                entry={e}
                hintMode={showFilter ? 'prompts' : hintMode}
                onChanged={(next) => setEntries((cur) => (cur ?? []).map((x) => (x.id === next.id ? next : x)))}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PromptsSection() {
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    void api('/api/prompts')
      .then((r) => {
        const list = r.prompts ?? [];
        const bySource = { system: 0, plugin: 0, res: 0, memory: 0, skills: 0, loop: 0, compact: 0 };
        for (const e of list) {
          const g = String(e.group);
          if (g === 'system') bySource.system += 1;
          else if (g.startsWith('plugin:')) bySource.plugin += 1;
          else if (g.startsWith('res:') || g === 'resources') bySource.res += 1;
          else if (g === 'memory') bySource.memory += 1;
          else if (g === 'skills') bySource.skills += 1;
          else if (g === 'loop') bySource.loop += 1;
          else bySource.compact += 1;
        }
        setCounts({ total: list.length, bySource });
      })
      .catch(() => setCounts(null));
  }, []);

  return (
    <Section
      title="提示词（全部汇总）"
      desc="这里是模型实际看到的**全部**文本：系统与循环文案、插件用法与工具描述、记忆与技能的注入语、外部资源说明。默认值来自代码，改动存在 data/prompts.json；各模块页（插件/记忆/技能/外部资源）改的也是这里同一条记录，两边完全等价。保存后下一轮生效。"
    >
      {counts ? (
        <p className="mb-2 text-[11px] text-subtle">
          共 {counts.total} 条 —— 系统 {counts.bySource.system} · 循环 {counts.bySource.loop} · 插件 {counts.bySource.plugin} · 外部资源{' '}
          {counts.bySource.res} · 记忆 {counts.bySource.memory} · 技能 {counts.bySource.skills} · 压缩 {counts.bySource.compact}
        </p>
      ) : null}
      <PromptsList showFilter />
    </Section>
  );
}
