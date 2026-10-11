/**
 * ui/features/settings/SystemSection.jsx —— 系统：智能体**怎么跑**的参数（与"这次请求发什么"无关）。
 *
 * 为什么单开一页（2026-10-10 第十一轮归一）：此前轮次上限、并发、落盘、停滞看门狗
 * 都混在「模型与参数」里，概念上不是模型参数，混着放导致"模型页"像大杂烩。
 * 现在按归属拆开：
 *   · 「模型」= 服务商 + 模型调用参数（temperature/maxTokens/超时/重试/上下文窗口/思考预算）；
 *   · 「系统」= 本页：轮次、并发、上游鲁棒性、超长结果落盘、检查点列表窗口、排队默认；
 *   · 「插件」= 每个插件自己的预算（子智能体的轮次上限就在子智能体插件里）。
 *
 * 原则（需求）：**不设服务端硬上限**，用户填多少就多少；真跑飞了用界面上的「停止」中断。
 * 每一项都在这里可见、可改，改完即时生效（下一个 start / 下一次工具结果就按新配置走）。
 */
import { useEffect, useState } from 'react';
import { api } from '../../state/api.js';
import { useApp, patch, toast } from '../../state/store.js';
import { Btn, Field, Input, Section, Select, Spinner, Toggle } from '../ui.jsx';

/** 数字型系统参数：key / 说明 / 步长。0 的含义写进说明（各处不同）。 */
const NUM_FIELDS = [
  {
    key: 'maxRounds',
    desc: '单次运行轮次上限（0 = 自动，按插件额度汇总；不设上限）',
    step: 1,
  },
  {
    key: 'maxRuns',
    desc: '同时运行的会话数上限（0 = 不限制）',
    step: 1,
  },
  {
    key: 'stallSec',
    desc: '上游停滞看门狗：这么久没任何字节就中止本次调用并重试（秒，0 = 关）',
    step: 1,
  },
  {
    key: 'autoContinueMax',
    desc: '自动续跑最多几次（需先打开下面的开关）',
    step: 1,
  },
  {
    key: 'spillMaxChars',
    desc: '工具结果超过多少字符才落盘（0 = 关，全部内联）',
    step: 1000,
  },
  {
    key: 'spillHeadChars',
    desc: '落盘预览保留的开头字符数',
    step: 500,
  },
  {
    key: 'spillTailChars',
    desc: '落盘预览保留的结尾字符数',
    step: 500,
  },
  {
    key: 'checkpointLimit',
    desc: '文件改动检查点列表最多列多少条（0 = 不限制，列出全部）',
    step: 50,
  },
];

const QUEUE_DEFAULTS = [
  { value: 'queue', label: '排队（当前这一段跑完后自动执行）—— 推荐' },
  { value: 'steer', label: '插话（当前轮次的下个安全点注入）' },
  { value: 'urgent', label: '打断（掐掉当前调用立刻转向）' },
];

export default function SystemSection() {
  const st = useApp();
  const [sys, setSys] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api('/api/settings');
      setSys(r.system ?? {});
      patch({ settings: r });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const body = {};
      for (const f of NUM_FIELDS) body[f.key] = Number(sys?.[f.key]) || 0;
      for (const k of ['autoContinue', 'spillEnabled']) body[k] = Boolean(sys?.[k]);
      body.queueDefault = String(sys?.queueDefault ?? 'queue');
      const r = await api('/api/settings', { method: 'POST', body: { system: body } });
      setSys(r.system ?? {});
      patch({ settings: r });
      toast('系统参数已保存（下一段运行就按新配置走）', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="运行与预算"
        desc="智能体怎么跑。**一律不设服务端硬上限**：填多少就多少，真跑飞了用界面上的「停止」中断。"
        actions={
          <Btn size="sm" variant="primary" disabled={busy || !sys} onClick={() => void save()}>
            {busy ? <Spinner className="size-3" /> : null}
            保存系统参数
          </Btn>
        }
      >
        {!sys ? (
          <p className="flex items-center gap-2 py-2 text-xs text-subtle">
            <Spinner className="size-3.5" />
            正在读设置…
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {NUM_FIELDS.map((f) => (
            <Field key={f.key} label={f.desc} hint={f.key}>
              <Input
                type="number"
                step={f.step}
                value={sys?.[f.key] ?? 0}
                disabled={!sys}
                onChange={(e) => setSys((cur) => ({ ...(cur ?? {}), [f.key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="重试预算用完后自动续跑（默认关，免得掩盖真问题）" hint="autoContinue">
            <div className="pt-1">
              <Toggle
                checked={Boolean(sys?.autoContinue)}
                disabled={!sys}
                onChange={(v) => setSys((cur) => ({ ...(cur ?? {}), autoContinue: v }))}
              />
            </div>
          </Field>
          <Field label="超长工具结果落盘（只回灌头尾预览 + 可 read_file 的路径）" hint="spillEnabled">
            <div className="pt-1">
              <Toggle
                checked={Boolean(sys?.spillEnabled)}
                disabled={!sys}
                onChange={(v) => setSys((cur) => ({ ...(cur ?? {}), spillEnabled: v }))}
              />
            </div>
          </Field>
        </div>
      </Section>

      <Section
        title="运行中发消息的默认行为"
        desc="运行中再发一句话时，Enter 走哪种语义。无论选哪个，「立即执行」永远是打断（当前轮次内立刻反馈）——它是唯一的当前轮次内插队入口。"
      >
        <Field label="默认语义" hint="queueDefault">
          <Select
            value={String(sys?.queueDefault ?? 'queue')}
            disabled={!sys}
            onChange={(e) => setSys((cur) => ({ ...(cur ?? {}), queueDefault: e.target.value }))}
          >
            {QUEUE_DEFAULTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </Section>
    </div>
  );
}
