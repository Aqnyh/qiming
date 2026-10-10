/**
 * ui/features/settings/ModelsSection.jsx —— 模型与参数。
 *
 * 服务商是**整份提交**的（POST /api/settings {providers:[...]}），服务端按 id 合并：
 * apiKey 传空串/不传 = 保持原值（界面只显示 keyHint 掩码），传 null = 清除。
 * 所以编辑器以服务端返回的脱敏数据为底稿，只把用户真填的新 key 带上（"留空=不改"）。
 *
 * 项目（工作目录）已独立成「设置 → 项目」板块（需求 3）：这里只管模型与采样参数。
 */
import { useEffect, useState } from 'react';
import { api } from '../../state/api.js';
import { useApp, patch, toast } from '../../state/store.js';
import { Badge, Btn, Field, Icon, Input, Section, Select, Spinner, Toggle } from '../ui.jsx';

const PARAM_FIELDS = [
  { key: 'temperature', name: 'temperature', desc: '采样温度', step: 0.1 },
  // 上游鲁棒性（见 ARCHITECTURE「上游故障的应对」）：
  // stallSec 是"连上了但一个字节都不吐"的看门狗；autoContinue 是重试预算用完后还接着试（默认关）
  { key: 'stallSec', name: 'stallSec', desc: '上游停滞多久算卡住（秒，0=关）', step: 1 },
  { key: 'autoContinue', name: 'autoContinue', desc: '重试预算用完后自动续跑', kind: 'bool' },
  { key: 'autoContinueMax', name: 'autoContinueMax', desc: '自动续跑最多几次', step: 1 },
  { key: 'maxTokens', name: 'maxTokens', desc: '单次回答上限', step: 1 },
  { key: 'thinkingBudget', name: 'thinkingBudget', desc: '扩展思考预算（token，0 = 关）', step: 1 },
  { key: 'callTimeoutSec', name: 'callTimeoutSec', desc: '单次模型调用超时（秒）', step: 1 },
  { key: 'retryCount', name: 'retryCount', desc: '上游错误自动重试次数', step: 1 },
  { key: 'ctxLimit', name: 'ctxLimit', desc: '上下文窗口上限（token，0 = 不压缩）', step: 1 },
];

const newProvider = () => ({
  id: `p-${Date.now().toString(36)}`,
  name: '新服务商',
  type: 'openai',
  baseUrl: 'https://api.example.com/v1',
  model: '',
  ctxLimit: 0,
  note: '',
  apiKeyDraft: '',
});

export default function ModelsSection() {
  const st = useApp();
  const [providers, setProviders] = useState(null); // 编辑草稿（整份）
  const [params, setParams] = useState(null);
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api('/api/settings');
      setProviders((r.providers ?? []).map((p) => ({ ...p, apiKeyDraft: '' })));
      setParams(r.params ?? {});
      setActiveId(r.activeId ?? '');
      patch({ settings: r }); // 让顶栏等其它读 settings 的地方同步
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const setP = (i, k, v) => setProviders((list) => list.map((p, idx) => (idx === i ? { ...p, [k]: v } : p)));

  const saveProviders = async () => {
    setBusy(true);
    try {
      const body = providers.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        model: p.model,
        ctxLimit: Number(p.ctxLimit) || 0,
        note: p.note ?? '',
        // 留空 = 不改（服务端按 id 合并，undefined 保持原 key）
        ...(String(p.apiKeyDraft ?? '').trim() ? { apiKey: String(p.apiKeyDraft).trim() } : {}),
      }));
      const r = await api('/api/settings', { method: 'POST', body: { providers: body } });
      setProviders((r.providers ?? []).map((p) => ({ ...p, apiKeyDraft: '' })));
      setActiveId(r.activeId ?? '');
      patch({ settings: r });
      toast('服务商配置已保存', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const activate = async (id) => {
    try {
      const r = await api('/api/settings', { method: 'POST', body: { activeId: id } });
      setActiveId(r.activeId ?? id);
      patch({ settings: r });
      toast('已切换当前服务商', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const saveParams = async () => {
    setBusy(true);
    try {
      const body = {};
      for (const f of PARAM_FIELDS) body[f.key] = f.kind === 'bool' ? Boolean(params?.[f.key]) : Number(params?.[f.key]) || 0;
      const r = await api('/api/settings', { method: 'POST', body: { params: body } });
      setParams(r.params ?? {});
      patch({ settings: r });
      toast('参数已保存', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* ─── 服务商 ─── */}
      <Section
        title="模型服务商"
        desc="apiKey 留空 = 不改（服务端只回掩码，界面永远拿不到原 key）。整份保存：新增/删除/改名都在这一个按钮里。"
        actions={
          <>
            <Btn size="sm" onClick={() => setProviders((l) => [...(l ?? []), newProvider()])}>
              <Icon name="plus" className="size-3" />
              加服务商
            </Btn>
            <Btn size="sm" variant="primary" disabled={busy || !providers} onClick={() => void saveProviders()}>
              {busy ? <Spinner className="size-3" /> : null}
              保存全部
            </Btn>
          </>
        }
      >
        {!providers ? (
          <p className="flex items-center gap-2 py-2 text-xs text-subtle">
            <Spinner className="size-3.5" />
            正在读设置…
          </p>
        ) : null}
        {providers && !providers.length ? <p className="py-2 text-xs text-warn">还没有服务商：加一个（Base URL + 模型名 + Key）才能开始对话。</p> : null}
        <div className="flex flex-col gap-2">
          {(providers ?? []).map((p, i) => (
            <div key={p.id} className={`rounded-xl border p-2.5 ${p.id === activeId ? 'border-accent/40 bg-panel/60' : 'border-line/60 bg-panel/30'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] text-subtle">{p.id}</span>
                {p.id === activeId ? <Badge tone="accent">当前使用</Badge> : null}
                {p.hasKey ? <Badge>key {p.keyHint}</Badge> : <Badge tone="warn">没有 key</Badge>}
                <span className="flex-1" />
                {p.id !== activeId ? (
                  <Btn size="sm" onClick={() => void activate(p.id)}>
                    设为当前
                  </Btn>
                ) : null}
                <Btn size="sm" variant="danger" onClick={() => setProviders((l) => l.filter((x) => x.id !== p.id))} title="删除（保存后生效）">
                  <Icon name="trash" className="size-3" />
                </Btn>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label="名字">
                  <Input value={p.name} onChange={(e) => setP(i, 'name', e.target.value)} />
                </Field>
                <Field label="协议">
                  <Select value={p.type} onChange={(e) => setP(i, 'type', e.target.value)}>
                    <option value="openai">openai（兼容网关）</option>
                    <option value="anthropic">anthropic</option>
                  </Select>
                </Field>
                <Field label="模型名">
                  <Input value={p.model} onChange={(e) => setP(i, 'model', e.target.value)} placeholder="gpt-5.2 / claude-…" />
                </Field>
                <Field label="Base URL" className="sm:col-span-2">
                  <Input value={p.baseUrl} onChange={(e) => setP(i, 'baseUrl', e.target.value)} />
                </Field>
                <Field label="上下文窗口（token，0=不提示）">
                  <Input type="number" value={p.ctxLimit ?? 0} onChange={(e) => setP(i, 'ctxLimit', e.target.value)} />
                </Field>
                <Field label={`API Key（留空不改${p.hasKey ? `，当前 ${p.keyHint}` : ''}）`} className="sm:col-span-2">
                  <Input
                    type="password"
                    value={p.apiKeyDraft ?? ''}
                    onChange={(e) => setP(i, 'apiKeyDraft', e.target.value)}
                    placeholder={p.hasKey ? '（保持不变）' : '粘贴 key'}
                    autoComplete="off"
                  />
                </Field>
                <Field label="备注">
                  <Input value={p.note ?? ''} onChange={(e) => setP(i, 'note', e.target.value)} />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ─── 采样参数 ─── */}
      <Section
        title="采样与运行参数"
        desc="对全部服务商生效；thinkingBudget 只在支持的协议上起作用（Anthropic 扩展思考等）。"
        actions={
          <Btn size="sm" variant="primary" disabled={busy || !params} onClick={() => void saveParams()}>
            {busy ? <Spinner className="size-3" /> : null}
            保存参数
          </Btn>
        }
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {PARAM_FIELDS.map((f) =>
            f.kind === 'bool' ? (
              <Field key={f.key} label={f.desc} hint={f.key}>
                <div className="pt-1">
                  <Toggle
                    checked={Boolean(params?.[f.key])}
                    disabled={!params}
                    onChange={(v) => setParams((cur) => ({ ...(cur ?? {}), [f.key]: v }))}
                  />
                </div>
              </Field>
            ) : (
              <Field key={f.key} label={f.desc} hint={f.key}>
                <Input
                  type="number"
                  step={f.step}
                  value={params?.[f.key] ?? 0}
                  disabled={!params}
                  onChange={(e) => setParams((cur) => ({ ...(cur ?? {}), [f.key]: e.target.value }))}
                />
              </Field>
            ),
          )}
        </div>
      </Section>
    </div>
  );
}
