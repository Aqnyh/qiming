/**
 * ui/features/settings/PluginsSection.jsx —— 插件板块（需求 3）。
 *
 * 一个插件 = 用法提示词 + 若干可执行工具 + 参数。界面上要能：
 *  启用/停用、改参数（数值/文本/开关）、改用法提示词（可恢复默认）、看工具清单与描述；
 *  自定义插件还能新建/编辑整份定义（id/name/desc/prompt/params/tools；tool 有
 *  name/desc/schema(JSON)/command/stdin），以及删除。
 * 服务端对参数值不设硬上限（插件自己的预算，"用户填多少就是多少"），界面只做类型转换。
 */
import { useEffect, useState } from 'react';
import { api } from '../../state/api.js';
import { askConfirm, toast } from '../../state/store.js';
import { Area, Badge, Btn, Field, Icon, Input, Section, Spinner, Toggle, tryParseJson } from '../ui.jsx';
import { fmtChars } from '../../lib/format.js';

/* ────────────────────────── 参数编辑 ────────────────────────── */

function ParamsEditor({ plugin, onSaved }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(plugin.params.map((p) => [p.key, p.value])));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(Object.fromEntries(plugin.params.map((p) => [p.key, p.value])));
  }, [plugin, dirty]);

  if (!plugin.params.length) return null;

  const save = async () => {
    setBusy(true);
    try {
      const params = {};
      for (const p of plugin.params) {
        const v = draft[p.key];
        if (p.type === 'number') params[p.key] = Number(v);
        else if (p.type === 'boolean') params[p.key] = Boolean(v);
        else params[p.key] = String(v ?? '');
      }
      const r = await api(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'POST', body: { params } });
      onSaved(r.plugins);
      setDirty(false);
      toast('参数已保存', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-line/60 bg-panel/30 p-2">
      <p className="mb-1.5 text-[11px] text-subtle">参数（模型每次调用能用的预算；没有服务端硬上限，填多少就是多少）</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {plugin.params.map((p) => (
          <Field key={p.key} label={`${p.name}（${p.key}${p.type === 'number' ? ' · 秒/次数' : ''}）`} hint={p.desc}>
            {p.type === 'boolean' ? (
              <Toggle
                checked={Boolean(draft[p.key])}
                onChange={(v) => {
                  setDraft((d) => ({ ...d, [p.key]: v }));
                  setDirty(true);
                }}
              />
            ) : (
              <Input
                type={p.type === 'number' ? 'number' : 'text'}
                value={draft[p.key] ?? ''}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [p.key]: e.target.value }));
                  setDirty(true);
                }}
              />
            )}
          </Field>
        ))}
      </div>
      <div className="mt-1.5 flex justify-end">
        <Btn size="sm" variant={dirty ? 'primary' : 'outline'} disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? <Spinner className="size-3" /> : null}
          保存参数
        </Btn>
      </div>
    </div>
  );
}

/* ────────────────────────── 用法提示词 ────────────────────────── */

function PromptEditor({ plugin, onSaved }) {
  const [text, setText] = useState(plugin.prompt);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dirty) setText(plugin.prompt);
  }, [plugin.prompt, dirty]);

  const save = async (value) => {
    setBusy(true);
    try {
      const r = await api(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'POST', body: { prompt: value } });
      onSaved(r.plugins);
      setDirty(false);
      toast('用法提示词已保存，下一轮生效', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">
        用法提示词（告诉模型这个插件能做什么、怎么用）· {fmtChars(text.length)}
        {text !== plugin.defaultPrompt ? <span className="ml-1 text-accent">已改</span> : null}
      </summary>
      <div className="mt-1.5">
        <Area
          value={text}
          rows={Math.min(14, Math.max(3, text.split('\n').length))}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="flex-1" />
          {text !== plugin.defaultPrompt ? (
            <Btn
              size="sm"
              disabled={busy}
              onClick={() => {
                setText(plugin.defaultPrompt);
                setDirty(true);
                void save(plugin.defaultPrompt);
              }}
              title="用代码里的默认用法提示词覆盖当前文本"
            >
              恢复默认
            </Btn>
          ) : null}
          <Btn size="sm" variant={dirty ? 'primary' : 'outline'} disabled={!dirty || busy} onClick={() => void save(text)}>
            {busy ? <Spinner className="size-3" /> : null}
            保存
          </Btn>
        </div>
      </div>
    </details>
  );
}

/* ────────────────────────── 工具清单 ────────────────────────── */

function ToolsList({ plugin }) {
  if (!plugin.tools.length) return <p className="mt-2 text-[11px] text-subtle">这个插件没有工具。</p>;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">工具清单（{plugin.tools.length} 个）</summary>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {plugin.tools.map((t) => (
          <details key={t.name} className="rounded-lg border border-line/60 bg-panel/30 px-2 py-1.5">
            <summary className="cursor-pointer">
              <span className="font-mono text-[11px] text-fg">{t.name}</span>
              <span className="ml-2 text-[11px] text-muted">{t.desc}</span>
            </summary>
            <pre className="thin-scroll mt-1.5 max-h-56 overflow-auto rounded-md border border-line/60 bg-bg/70 p-2 font-mono text-[10.5px] leading-relaxed">{JSON.stringify(t.schema ?? {}, null, 2)}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

/* ────────────────────────── 单个插件 ────────────────────────── */

function PluginCard({ plugin, reload, onEditCustom }) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'POST', body: { enabled: !plugin.enabled } });
      reload(r.plugins);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!askConfirm(`删除自定义插件「${plugin.name}」？它带来的工具会立刻从模型手里消失。`)) return;
    try {
      const r = await api(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: 'DELETE' });
      reload(r.plugins);
      toast('已删除', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className={`rounded-xl border p-2.5 ${plugin.enabled ? 'border-line bg-panel/50' : 'border-line/50 bg-panel/30 opacity-75'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">{plugin.name}</span>
        <span className="font-mono text-[10px] text-subtle">{plugin.id}</span>
        <Badge tone={plugin.builtin ? 'default' : 'accent'}>{plugin.builtin ? '内置' : '自定义'}</Badge>
        {plugin.tools.length ? <span className="text-[10.5px] text-subtle">{plugin.tools.length} 个工具</span> : null}
        <span className="flex-1" />
        {!plugin.builtin ? (
          <>
            <Btn size="sm" onClick={() => onEditCustom(plugin)} title="编辑这份自定义定义">
              <Icon name="edit" className="size-3" />
              编辑
            </Btn>
            <Btn size="sm" variant="danger" onClick={() => void remove()}>
              <Icon name="trash" className="size-3" />
              删除
            </Btn>
          </>
        ) : null}
        <Toggle checked={plugin.enabled} onChange={() => void toggle()} disabled={busy} title={plugin.enabled ? '停用（下轮起模型看不到它的工具）' : '启用'} />
      </div>
      {plugin.desc ? <p className="mt-1 text-[11px] leading-relaxed text-subtle">{plugin.desc}</p> : null}
      <ParamsEditor plugin={plugin} onSaved={reload} />
      <PromptEditor plugin={plugin} onSaved={reload} />
      <ToolsList plugin={plugin} />
    </div>
  );
}

/* ────────────────────────── 自定义插件编辑器 ────────────────────────── */

const BLANK = {
  id: '',
  name: '',
  desc: '',
  prompt: '',
  enabled: true,
  paramsText: '[\n  { "key": "timeout_sec", "name": "单次调用超时（秒）", "type": "number", "def": 300 }\n]',
  toolsText:
    '[\n  {\n    "name": "my_tool",\n    "desc": "这个工具做什么（模型靠这句话决定用不用）",\n    "schema": { "type": "object", "properties": { "arg": { "type": "string", "description": "参数说明" } }, "required": ["arg"], "additionalProperties": false },\n    "command": "echo {arg}",\n    "stdin": "none"\n  }\n]',
};

function CustomEditor({ initial, onCancel, onSaved }) {
  const [form, setForm] = useState(initial ?? BLANK);
  const [busy, setBusy] = useState(false);
  const editing = Boolean(initial);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const params = tryParseJson(form.paramsText, []);
    if (params.error) return toast(`params：${params.error}`, 'error');
    const tools = tryParseJson(form.toolsText, []);
    if (tools.error) return toast(`tools：${tools.error}`, 'error');
    if (!form.id.trim() || !form.name.trim()) return toast('id 与 name 必填', 'error');
    setBusy(true);
    try {
      const r = await api('/api/plugins', {
        method: 'POST',
        body: {
          id: form.id.trim(),
          name: form.name.trim(),
          desc: form.desc,
          prompt: form.prompt,
          enabled: form.enabled,
          params: params.value,
          tools: tools.value,
        },
      });
      onSaved(r.plugins);
      toast('已保存自定义插件', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={editing ? `编辑自定义插件：${initial.name}` : '新建自定义插件'}
      desc="命令模板里 {参数名} 会被替换成 shell 安全转义的参数值；stdin=json 时参数 JSON 从标准输入进（适合参数多的命令）。"
      actions={
        <>
          <Btn size="sm" onClick={onCancel}>
            取消
          </Btn>
          <Btn size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner className="size-3" /> : null}
            保存
          </Btn>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="id（字母数字与 -，唯一）">
          <Input value={form.id} disabled={editing} onChange={(e) => set('id', e.target.value)} placeholder="my-plugin" />
        </Field>
        <Field label="名字">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="我的插件" />
        </Field>
      </div>
      <Field label="说明（一句话，给人看也给模型参考）" className="mt-2">
        <Input value={form.desc} onChange={(e) => set('desc', e.target.value)} />
      </Field>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-muted">启用</span>
        <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} />
      </div>
      <Field label="用法提示词（注入系统提示词，告诉模型怎么用这些工具）" className="mt-2">
        <Area value={form.prompt} rows={4} spellCheck={false} onChange={(e) => set('prompt', e.target.value)} />
      </Field>
      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <Field label="params（JSON 数组：key/name/type/def/desc）">
          <Area value={form.paramsText} rows={8} spellCheck={false} onChange={(e) => set('paramsText', e.target.value)} />
        </Field>
        <Field label="tools（JSON 数组：name/desc/schema/command/stdin）">
          <Area value={form.toolsText} rows={8} spellCheck={false} onChange={(e) => set('toolsText', e.target.value)} />
        </Field>
      </div>
    </Section>
  );
}

/* ────────────────────────── 板块 ────────────────────────── */

export default function PluginsSection() {
  const [plugins, setPlugins] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null); // null | BLANK（新建）| 编辑态表单

  const load = async () => {
    setErr('');
    try {
      const r = await api('/api/plugins');
      setPlugins(r.plugins ?? []);
    } catch (e) {
      setErr(e?.message ?? String(e));
      setPlugins([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onSaved = (next) => {
    setPlugins(next ?? []);
    setEditing(null);
  };

  const startEdit = (plugin) => {
    const raw = plugin.raw ?? {};
    setEditing({
      id: raw.id ?? plugin.id,
      name: raw.name ?? plugin.name,
      desc: raw.desc ?? plugin.desc,
      prompt: raw.prompt ?? plugin.prompt,
      enabled: raw.enabled !== false,
      paramsText: JSON.stringify(raw.params ?? [], null, 2),
      toolsText: JSON.stringify(
        (raw.tools ?? []).map((t) => ({ name: t.name, desc: t.desc, schema: t.schema, command: t.command, ...(t.stdin ? { stdin: t.stdin } : {}) })),
        null,
        2,
      ),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Section
        title="插件"
        desc="插件 = 用法提示词 + 可执行工具。启停与参数改完即时生效；运行中的会话下一轮也按新配置走。外部资源（ComfyUI、屏幕、浏览器…）不在这里，见「外部资源」页；插件也可由 agent 直接改 data/plugins.json 新增（改完自动热加载）。"
        actions={
          <Btn size="sm" variant={editing && !editing.id ? 'primary' : 'outline'} onClick={() => setEditing(editing ? null : { ...BLANK })}>
            <Icon name="plus" className="size-3" />
            新建自定义插件
          </Btn>
        }
      >
        {editing ? <CustomEditor initial={editing.id ? editing : null} onCancel={() => setEditing(null)} onSaved={onSaved} /> : null}
      </Section>

      {err ? <p className="rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">{err}</p> : null}
      {!plugins ? (
        <p className="flex items-center gap-2 py-3 text-xs text-subtle">
          <Spinner className="size-3.5" />
          正在读插件…
        </p>
      ) : null}
      {plugins?.map((p) => (
        <PluginCard key={p.id} plugin={p} reload={setPlugins} onEditCustom={startEdit} />
      ))}
    </div>
  );
}
