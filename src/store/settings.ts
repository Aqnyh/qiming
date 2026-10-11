/**
 * src/store/settings.ts —— 全局设置：服务商（模型）、采样参数、界面偏好。
 *
 * 与旧项目的区别：不做密钥 TOFU 校验、不做"来源账号回落"（单用户），
 * 但保留"缺省字段保持原值"的补丁语义 —— 界面上只改一个开关时，
 * 不能把没提交的字段顺手清空（旧项目因此丢过整份服务商配置）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig } from '../providers/types.ts';
import { readJson, writeJson, now } from './kv.ts';
import { SETTINGS_FILE } from '../util/paths.ts';

export type Provider = ProviderConfig & {
  /** 界面上展示用的备注 */
  note?: string;
  createdAt?: number;
};

/**
 * `ModelParams` —— **模型调用本身**的参数（只放"发给上游的那次请求"相关的东西）。
 *
 * 界面入口：「设置 → 模型」。不属于模型调用的一律去 {@link SystemSettings}
 * （这是 2026-10-10 第十一轮归一：此前 maxRounds/spill 等混在"模型与参数"里，
 * 概念上不是模型参数，混着放导致"模型页"看着像大杂烩）。
 */
export type ModelParams = {
  temperature?: number;
  maxTokens?: number;
  /** 扩展思考预算（Anthropic thinking.budget_tokens / 语法糖） */
  thinkingBudget?: number;
  /** 单次模型调用超时（秒），到时中止并重试 */
  callTimeoutSec?: number;
  /** 上游错误自动重试次数 */
  retryCount?: number;
  /** 上下文窗口上限（token），0 = 不压缩 */
  ctxLimit?: number;
  /** 是否把思考内容回传（仅少数网关需要） */
  echoThinking?: boolean;
};

/** 运行中发消息的默认语义（与 server/run-types.ts 的 SteerMode 同构，此处不反向依赖 server） */
export type QueueDefault = 'steer' | 'urgent' | 'queue';

/**
 * `SystemSettings` —— **系统参数**：智能体怎么跑，与"这次请求发什么"无关。
 *
 * 界面入口：「设置 → 系统」。**一律不设服务端硬上限**：用户填多少就多少
 * （真跑飞了用界面上的「停止」中断）。
 */
export type SystemSettings = {
  /**
   * 单次运行的**轮次上限**（模型一次调用算一轮；工具结果回灌后再算下一轮）。
   * `0`（默认）= 自动：按各插件声明的 max_calls 汇总，再留 2 轮余量。
   */
  maxRounds?: number;
  /**
   * 全局同时运行的会话数上限。`0` = 不限制。
   * 缺省时回落 `QIMING_MAX_RUNS` 环境变量，再回落 8（历史默认）。
   */
  maxRuns?: number;
  /** 停滞看门狗：这么久没有任何字节就中止本次调用并重试（秒，0 = 关） */
  stallSec?: number;
  /** 自动续跑：重试预算用完后还接着试（默认关 —— 无限续跑有时会掩盖真问题） */
  autoContinue?: boolean;
  /** 自动续跑最多几次 */
  autoContinueMax?: number;
  /**
   * 超长工具结果落盘（spill）：把大输出写到 runSpillDir，只把「头尾预览 + 路径」回灌给模型。
   * `spillEnabled=false` 或 `spillMaxChars=0` 表示关（全部内联）。
   */
  spillEnabled?: boolean;
  /** 超过多少字符才落盘（0 = 关） */
  spillMaxChars?: number;
  /** 预览保留的开头字符数 */
  spillHeadChars?: number;
  /** 预览保留的结尾字符数 */
  spillTailChars?: number;
  /**
   * 文件改动检查点**列表**最多列多少条（0 = 不限制，全列出）。
   * 检查点本身不会因为超限被删（都在 data/checkpoints/<会话id>/），只是列表窗口。
   */
  checkpointLimit?: number;
  /**
   * 运行中发消息的**默认**语义（界面 Enter 走它）：
   *   `queue`（默认）= 排在这一段运行之后自动执行；
   *   `steer` = 当前轮次的安全点注入；`urgent` = 打断当前调用立刻转向。
   * 无论默认是什么，队列条上的「立即执行」永远是 urgent（唯一的"当前轮次内反馈"）。
   */
  queueDefault?: QueueDefault;
};

export type Settings = {
  version: number;
  providers: Provider[];
  activeId: string | null;
  /** 模型调用参数（设置 → 模型） */
  params: ModelParams;
  /** 系统参数（设置 → 系统） */
  system: SystemSettings;
  /** 工作区根目录：**所有项目都必须落在它之下**（需求 3）。空 = 用默认值 */
  workspace: string;
  ui: Record<string, unknown>;
  updatedAt: number;
};

/**
 * 默认工作区：**不写死任何本机路径**，按覆盖面从宽到窄挑一个真实存在的目录。
 *
 * 优先顺序：环境变量 `QIMING_WORKSPACE` → `~/workspace`（有就继续往上取一层父目录）→ 家目录。
 * 用户在「设置 → 项目」里随时改成任何目录，这里只负责给一个能开箱即用的初值。
 */
export function defaultWorkspace(): string {
  const env = String(process.env.QIMING_WORKSPACE ?? '').trim();
  if (env) return env;
  const home = osHomeGuess();
  const candidate = path.join(home, 'workspace');
  try {
    if (fs.statSync(candidate).isDirectory()) return path.dirname(candidate);
  } catch {
    /* 没有就用家目录 */
  }
  return home;
}

function osHomeGuess(): string {
  return process.env.HOME || '/';
}

export const DEFAULT_PARAMS: Required<
  Pick<
    ModelParams,
    'temperature' | 'maxTokens' | 'callTimeoutSec' | 'retryCount' | 'ctxLimit'
  >
> = {
  temperature: 0.6,
  maxTokens: 8192,
  callTimeoutSec: 600,
  retryCount: 2,
  ctxLimit: 200_000,
};

export const DEFAULT_SYSTEM: Required<SystemSettings> = {
  maxRounds: 0,
  maxRuns: 8,
  stallSec: 90,
  autoContinue: false,
  autoContinueMax: 2,
  spillEnabled: true,
  spillMaxChars: 24_000,
  spillHeadChars: 4_000,
  spillTailChars: 4_000,
  checkpointLimit: 200,
  queueDefault: 'queue',
};

/**
 * 从**旧版扁平的 `params`** 里把系统参数迁到 `system`。
 *
 * 背景：第十一轮之前 maxRounds / subagentMaxRounds / spill* / stallSec / autoContinue*
 * 都塞在 `params` 里。现在 params 只留模型调用参数，其余搬到 system（子智能体轮次搬到
 * 插件参数，见 rounds.ts）。这里做一次**无损迁移**：旧存档里的值原样搬到新位置，
 * 迁完从 params 里删掉，免得两处各存一份、以后不知道该读哪个。
 */
function migrateSystem(curParams: Record<string, unknown>, curSystem: Record<string, unknown>): SystemSettings {
  const moved: SystemSettings = {};
  const keys: Array<keyof SystemSettings> = [
    'maxRounds',
    'maxRuns',
    'stallSec',
    'autoContinue',
    'autoContinueMax',
    'spillEnabled',
    'spillMaxChars',
    'spillHeadChars',
    'spillTailChars',
    'checkpointLimit',
    'queueDefault',
  ];
  for (const k of keys) {
    if (curSystem[k] !== undefined) moved[k] = curSystem[k] as never;
    else if (curParams[k] !== undefined) moved[k] = curParams[k] as never;
  }
  return { ...DEFAULT_SYSTEM, ...moved };
}

const EMPTY: Settings = {
  version: 2,
  providers: [],
  activeId: null,
  params: { ...DEFAULT_PARAMS, thinkingBudget: 0 },
  system: { ...DEFAULT_SYSTEM },
  workspace: '',
  ui: {},
  updatedAt: 0,
};

/** 模型参数里允许的键：旧的系统参数搬走后，只留这些（避免脏字段继续堆在 params） */
const MODEL_KEYS: Array<keyof ModelParams> = [
  'temperature',
  'maxTokens',
  'thinkingBudget',
  'callTimeoutSec',
  'retryCount',
  'ctxLimit',
  'echoThinking',
];

function modelParamsOf(raw: Record<string, unknown> | undefined): ModelParams {
  const src = raw ?? {};
  const out: ModelParams = { thinkingBudget: 0 };
  for (const k of MODEL_KEYS) {
    if (src[k] !== undefined) out[k] = src[k] as never;
  }
  return { ...DEFAULT_PARAMS, ...out };
}

export function readSettings(): Settings {
  const raw = readJson<Settings>(SETTINGS_FILE, EMPTY);
  return normalize(raw);
}

export function normalize(raw: Partial<Settings> | null | undefined): Settings {
  const cur = raw ?? {};
  const providers = Array.isArray(cur.providers) ? cur.providers.filter((p) => p && p.id) : [];
  const activeId = providers.some((p) => p.id === cur.activeId) ? (cur.activeId ?? null) : (providers[0]?.id ?? null);
  return {
    version: 2,
    providers,
    activeId,
    params: modelParamsOf(cur.params as Record<string, unknown> | undefined),
    system: migrateSystem(
      (cur.params ?? {}) as Record<string, unknown>,
      (cur.system ?? {}) as Record<string, unknown>,
    ),
    workspace: String(cur.workspace ?? '').trim() || defaultWorkspace(),
    ui: cur.ui && typeof cur.ui === 'object' ? cur.ui : {},
    updatedAt: cur.updatedAt ?? 0,
  };
}

export function saveSettings(next: Settings): Settings {
  const clean = normalize(next);
  clean.updatedAt = now();
  writeJson(SETTINGS_FILE, clean);
  return clean;
}

/** 补丁式保存：只改传进来的字段；providers 走整体替换（界面上就是整份编辑的） */
export function patchSettings(patch: Partial<Settings>): Settings {
  const cur = readSettings();
  const next: Settings = { ...cur };
  if (Array.isArray(patch.providers)) next.providers = patch.providers;
  if ('activeId' in patch) next.activeId = patch.activeId ?? null;
  if (patch.params && typeof patch.params === 'object') next.params = { ...cur.params, ...patch.params };
  if (patch.system && typeof patch.system === 'object') next.system = { ...cur.system, ...patch.system };
  if (typeof patch.workspace === 'string') next.workspace = patch.workspace.trim() || defaultWorkspace();
  if (patch.ui && typeof patch.ui === 'object') next.ui = { ...cur.ui, ...patch.ui };
  return saveSettings(next);
}

export function providerOf(settings: Settings, id?: string | null): Provider | null {
  const target = id ?? settings.activeId;
  return settings.providers.find((p) => p.id === target) ?? null;
}

/**
 * 一次性迁移：把旧存档 `params.subagentMaxRounds` 搬到**子智能体插件的参数** `max_rounds`。
 *
 * 为什么需要：第十一轮把"子智能体轮次上限"从系统设置挪到插件参数（归属更清楚）。
 * 但旧存档里用户设过的值（例如 30）如果直接丢掉就太粗暴了。这里读一次原始文件，
 * 若发现旧字段且插件里还没设过，就把它写进插件覆盖；随后 saveSettings 会把 settings
 * 归一（旧字段自然消失）。
 *
 * @returns 迁移到的值（没迁移返回 0）
 */
export function migrateLegacySubagentRounds(): number {
  const raw = readJson<{ params?: Record<string, unknown> }>(SETTINGS_FILE, {});
  const legacy = Math.trunc(Number(raw?.params?.subagentMaxRounds ?? 0));
  if (!(legacy > 0)) return 0;
  type PluginsFile = { version?: number; overrides?: Record<string, { enabled?: boolean; params?: Record<string, unknown> }>; custom?: unknown[]; updatedAt?: number };
  const pluginsFile = path.join(path.dirname(SETTINGS_FILE), 'plugins.json');
  const plugins = readJson<PluginsFile>(pluginsFile, {});
  const cur = plugins?.overrides?.subagent?.params?.max_rounds;
  if (Math.trunc(Number(cur ?? 0)) > 0) return 0; // 插件里已设过 → 不动
  const next: PluginsFile = {
    version: 1,
    overrides: {
      ...(plugins?.overrides ?? {}),
      subagent: {
        ...(plugins?.overrides?.subagent ?? {}),
        params: { ...(plugins?.overrides?.subagent?.params ?? {}), max_rounds: legacy },
      },
    },
    custom: plugins?.custom ?? [],
    updatedAt: now(),
  };
  writeJson(pluginsFile, next);
  return legacy;
}

/** 发出去的设置：密钥只回掩码（界面上"留空=不改"） */
export function publicSettings(s: Settings) {
  return {
    ...s,
    providers: s.providers.map((p) => ({
      ...p,
      apiKey: undefined,
      keyHint: p.apiKey ? `${p.apiKey.slice(0, 6)}…${p.apiKey.slice(-4)}` : '',
      hasKey: Boolean(p.apiKey),
    })),
  };
}

/** 应用界面传来的补丁：apiKey 为空串/undefined = 保持原值；显式 null = 清除 */
export function mergeProviders(cur: Provider[], incoming: Array<Partial<Provider> & { id: string }>): Provider[] {
  const byId = new Map(cur.map((p) => [p.id, p]));
  const out: Provider[] = [];
  for (const raw of incoming) {
    if (!raw?.id) continue;
    const old = byId.get(raw.id);
    const apiKey =
      raw.apiKey === undefined || raw.apiKey === ''
        ? old?.apiKey
        : raw.apiKey === null
          ? undefined
          : raw.apiKey;
    out.push({ ...(old ?? {}), ...raw, apiKey, createdAt: old?.createdAt ?? now() } as Provider);
  }
  return out;
}
