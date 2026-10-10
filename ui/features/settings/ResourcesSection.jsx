/**
 * ui/features/settings/ResourcesSection.jsx —— 外部资源板块（需求 3）。
 *
 * 外部资源 = 本机可调用的外部能力（mcp / http / command 三种形态）。
 * **与插件分开**（需求 1）：工具虽然进模型工具表，但在界面上只归这一页 ——
 * 每张卡上能看到连接状态、工具清单、调用参数、以及它自己的提示词（资源说明 + 每个工具的描述），
 * 并且都能在这里直接改（改的是提示词中心里的同一条记录，与提示词页完全等价）。
 * 底部还写明文件位置：agent 也能直接改 data/resources.json 来新增/修改资源。
 *
 * 编辑走整份 upsert（POST /api/resources）：服务端存的是完整对象，
 * 所以编辑器以现有 view 为底稿（去掉 status/toolList 这两个派生字段）再改，
 * 避免"只改一个字段却把没带上的字段清空"（服务端 mergeProviders 的同类教训）。
 */
import { useEffect, useState } from 'react';
import { api } from '../../state/api.js';
import { askConfirm, toast } from '../../state/store.js';
import { Area, Badge, Btn, Field, Icon, Input, Section, Select, Spinner, Toggle, tryParseJson } from '../ui.jsx';
import { PromptsList } from './PromptsSection.jsx';

const KIND_NAMES = { mcp: 'MCP 服务器', http: 'HTTP 端点', command: '本地命令' };

const stripView = (view) => {
  const { status, toolList, ...rest } = view ?? {};
  return rest;
};

const toDraft = (resource) => ({
  base: stripView(resource),
  id: resource.id ?? '',
  name: resource.name ?? '',
  kind: resource.kind ?? 'http',
  desc: resource.desc ?? '',
  enabled: resource.enabled !== false,
  command: resource.command ?? '',
  cwd: resource.cwd ?? '',
  baseUrl: resource.baseUrl ?? '',
  actionsText: JSON.stringify(resource.actions ?? [], null, 2),
  toolsText: JSON.stringify(resource.tools ?? [], null, 2),
  isNew: !resource.id,
});

function ResourceEditor({ draft, setDraft, onCancel, onSaved }) {
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (!draft.id.trim() || !draft.name.trim()) return toast('id / name 必填', 'error');
    const actions = tryParseJson(draft.actionsText, []);
    if (actions.error) return toast(`actions：${actions.error}`, 'error');
    const tools = tryParseJson(draft.toolsText, []);
    if (tools.error) return toast(`tools：${tools.error}`, 'error');
    setBusy(true);
    try {
      const body = {
        ...draft.base, // 保住 env/headers/createdAt 等没在界面上展开的字段
        id: draft.id.trim(),
        name: draft.name.trim(),
        kind: draft.kind,
        desc: draft.desc,
        enabled: draft.enabled,
        command: draft.command,
        cwd: draft.cwd || undefined,
        baseUrl: draft.baseUrl,
        actions: actions.value,
        tools: tools.value,
      };
      await api('/api/resources', { method: 'POST', body });
      toast('资源已保存', 'ok');
      onSaved();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-accent/30 bg-panel/60 p-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="id（唯一）">
          <Input value={draft.id} disabled={!draft.isNew} onChange={(e) => set('id', e.target.value)} />
        </Field>
        <Field label="名字">
          <Input value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="形态">
          <Select value={draft.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="mcp">mcp（stdio MCP 服务器）</option>
            <option value="http">http（声明式端点）</option>
            <option value="command">command（本地命令模板）</option>
          </Select>
        </Field>
      </div>
      <Field label="说明（会注入系统提示词，告诉模型这台机器上还有什么可用）" className="mt-2">
        <Area value={draft.desc} rows={3} onChange={(e) => set('desc', e.target.value)} />
      </Field>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-muted">启用</span>
        <Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} />
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {draft.kind === 'mcp' || draft.kind === 'command' ? (
          <Field label="启动/命令（mcp：启动命令；command：工具 command 模板）">
            <Input value={draft.command} onChange={(e) => set('command', e.target.value)} placeholder="npx -y @some/mcp-server" />
          </Field>
        ) : null}
        {draft.kind === 'http' ? (
          <Field label="Base URL">
            <Input value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="http://127.0.0.1:8188" />
          </Field>
        ) : null}
        <Field label="工作目录 cwd（可留空）">
          <Input value={draft.cwd} onChange={(e) => set('cwd', e.target.value)} />
        </Field>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <Field label="actions（JSON 数组，http 用：name/desc/method/path/params/saveAs）">
          <Area value={draft.actionsText} rows={9} spellCheck={false} onChange={(e) => set('actionsText', e.target.value)} />
        </Field>
        <Field label="tools（JSON 数组，command 用：name/desc/schema/command/stdin/timeoutSec）">
          <Area value={draft.toolsText} rows={9} spellCheck={false} onChange={(e) => set('toolsText', e.target.value)} />
        </Field>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Btn size="sm" onClick={onCancel}>
          取消
        </Btn>
        <Btn size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner className="size-3" /> : null}
          保存（整份 upsert）
        </Btn>
      </div>
    </div>
  );
}

/**
 * 资源参数：值存在资源自己身上（resources.json），不跟插件挤一个文件。
 * 数字/布尔按 paramDefs 的类型转回来再提交（输入框给的都是字符串）。
 */
function ResourceParams({ res, onSaved }) {
  const defs = res.paramDefs ?? [];
  const [vals, setVals] = useState(() => ({ ...(res.params ?? {}) }));
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(vals) !== JSON.stringify(res.params ?? {});

  useEffect(() => {
    setVals({ ...(res.params ?? {}) });
  }, [JSON.stringify(res.params ?? {})]);

  if (!defs.length) return null;

  const save = async () => {
    setBusy(true);
    try {
      const body = {};
      for (const d of defs) {
        const v = vals[d.key];
        body[d.key] = d.type === 'number' ? Number(v) || 0 : d.type === 'boolean' ? Boolean(v) : String(v ?? '');
      }
      await api(`/api/resources/${encodeURIComponent(res.id)}`, { method: 'POST', body: { params: body } });
      toast('参数已保存', 'ok');
      onSaved?.();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-end gap-2 rounded-lg border border-line/60 bg-panel/30 px-2 py-1.5">
      <span className="text-[11px] text-muted">调用参数</span>
      {defs.map((d) => (
        <Field key={d.key} label={d.name} hint={d.key} className="w-40">
          <Input
            type={d.type === 'number' ? 'number' : 'text'}
            value={vals[d.key] ?? ''}
            onChange={(e) => setVals((cur) => ({ ...cur, [d.key]: e.target.value }))}
          />
        </Field>
      ))}
      <Btn size="sm" variant={dirty ? 'primary' : 'outline'} disabled={busy || !dirty} onClick={() => void save()}>
        {busy ? <Spinner className="size-3" /> : null}
        保存参数
      </Btn>
    </div>
  );
}

function StateBadge({ status }) {
  if (!status) return null;
  const tone = status.state === 'ready' ? 'ok' : status.state === 'error' ? 'danger' : 'default';
  const text = status.state === 'ready' ? '已连接' : status.state === 'error' ? '连接失败' : '未连接';
  return (
    <span title={status.detail}>
      <Badge tone={tone}>{text}</Badge>
    </span>
  );
}

export default function ResourcesSection() {
  const [resources, setResources] = useState(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState(null);
  const [testing, setTesting] = useState('');

  const load = async () => {
    setErr('');
    try {
      const r = await api('/api/resources');
      setResources(r.resources ?? []);
    } catch (e) {
      setErr(e?.message ?? String(e));
      setResources([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const test = async (res) => {
    setTesting(res.id);
    try {
      const r = await api(`/api/resources/${encodeURIComponent(res.id)}/test`, { method: 'POST', body: {} });
      toast(r.ok ? `连上了：${r.status?.detail ?? ''}` : `连不上：${r.status?.detail ?? '看资源卡片上的状态'}`, r.ok ? 'ok' : 'error');
      await load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setTesting('');
    }
  };

  const toggle = async (res) => {
    try {
      const r = await api(`/api/resources/${encodeURIComponent(res.id)}`, { method: 'POST', body: { enabled: !res.enabled } });
      setResources(r.resources ?? []);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const remove = async (res) => {
    if (!askConfirm(`删除外部资源「${res.name}」？它带来的工具会立刻消失。`)) return;
    try {
      const r = await api(`/api/resources/${encodeURIComponent(res.id)}`, { method: 'DELETE' });
      if (r.ok === false) toast('服务端说这条资源不存在（可能已删）', 'info');
      else toast('已删除', 'ok');
      await load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="外部资源"
        desc="mcp / http / command 三种形态。每张卡可直接看状态、测连接、改参数与提示词；也可由 agent 直接改 data/resources.json（改完自动热加载）。"
        actions={
          <Btn size="sm" variant="primary" onClick={() => setDraft(toDraft(null))}>
            <Icon name="plus" className="size-3" />
            新建资源
          </Btn>
        }
      >
        {err ? <p className="rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{err}</p> : null}
        {!resources ? (
          <p className="flex items-center gap-2 py-3 text-xs text-subtle">
            <Spinner className="size-3.5" />
            正在读资源…
          </p>
        ) : null}
        {resources && !resources.length ? <p className="py-3 text-xs text-subtle">还没有外部资源。</p> : null}
        <div className="mt-1 flex flex-col gap-2">
          {(resources ?? []).map((res) => (
            <div key={res.id} className={`rounded-xl border p-2.5 ${res.enabled ? 'border-line bg-panel/50' : 'border-line/50 bg-panel/30 opacity-75'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg">{res.name}</span>
                <span className="font-mono text-[10px] text-subtle">{res.id}</span>
                <Badge tone="accent">{KIND_NAMES[res.kind] ?? res.kind}</Badge>
                <StateBadge status={res.status} />
                <span className="text-[10.5px] text-subtle">{res.status?.tools ?? res.toolList?.length ?? 0} 个工具</span>
                <span className="flex-1" />
                <Btn size="sm" disabled={testing === res.id} onClick={() => void test(res)} title="对 mcp 会真的启动一次服务器并列工具">
                  {testing === res.id ? <Spinner className="size-3" /> : <Icon name="external" className="size-3" />}
                  测试连接
                </Btn>
                <Btn size="sm" onClick={() => setDraft(toDraft(res))}>
                  <Icon name="edit" className="size-3" />
                  编辑
                </Btn>
                <Btn size="sm" variant="danger" onClick={() => void remove(res)}>
                  <Icon name="trash" className="size-3" />
                </Btn>
                <Toggle checked={res.enabled} onChange={() => void toggle(res)} title={res.enabled ? '停用' : '启用'} />
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-subtle">{res.desc}</p>
              {res.status?.detail ? <p className="mt-0.5 text-[10.5px] text-subtle">状态：{res.status.detail}</p> : null}
              {res.toolList?.length ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">工具清单</summary>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {res.toolList.map((t) => (
                      <li key={t.name} className="text-[11px]">
                        <span className="font-mono text-fg">{t.name}</span>
                        <span className="ml-2 text-subtle">{t.desc}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <ResourceParams res={res} onSaved={load} />
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">提示词（资源说明 + 每个工具的描述）</summary>
                <div className="mt-1.5">
                  <PromptsList groups={[`res:${res.id}`]} />
                </div>
              </details>
              {draft && draft.id === res.id && !draft.isNew ? (
                <ResourceEditor draft={draft} setDraft={setDraft} onCancel={() => setDraft(null)} onSaved={() => { setDraft(null); void load(); }} />
              ) : null}
            </div>
          ))}
        </div>

        {draft && draft.isNew ? <ResourceEditor draft={draft} setDraft={setDraft} onCancel={() => setDraft(null)} onSaved={() => { setDraft(null); void load(); }} /> : null}
      </Section>

      <Section
        title="这些资源存在哪、怎么由 agent 自己加"
        desc="外部资源都在 data/resources.json 里；agent 可以直接读改写它来新增或修改资源（服务每 2 秒检查一次，改完自动生效，不用重启）。"
      >
        <ul className="flex flex-col gap-1 text-[11px] leading-relaxed text-subtle">
          <li>
            · 文件：<span className="font-mono text-muted">data/resources.json</span> —— 三种形态的字段表与例子见技能{' '}
            <span className="font-mono text-muted">agent-modules</span>（agent 用 <span className="font-mono">use_skill</span> 载入）。
          </li>
          <li>· 每张资源卡上的「参数」与「提示词」改的是同一份数据：参数存资源自己，提示词存提示词中心（与「提示词」页同一条）。</li>
          <li>· 加了 mcp 资源后会自动尝试连接；连不上时点「测试连接」看具体报错。</li>
        </ul>
      </Section>
    </div>
  );
}
