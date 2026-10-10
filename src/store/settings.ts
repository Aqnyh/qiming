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
  /** 停滞看门狗：这么久没有任何字节就中止本次调用并重试（秒，0 = 关） */
  stallSec?: number;
  /** 自动续跑：重试预算用完后还接着试（默认关 —— 无限续跑有时会掩盖真问题） */
  autoContinue?: boolean;
  /** 自动续跑最多几次 */
  autoContinueMax?: number;
};

export type Settings = {
  version: number;
  providers: Provider[];
  activeId: string | null;
  params: ModelParams;
  /** 工作区根目录：**所有项目都必须落在它之下**（需求 3）。空 = 用默认值 */
  workspace: string;
  ui: Record<string, unknown>;
  updatedAt: number;
};

/** 默认工作区：优先本机常见的 workspace 目录，其次家目录 */
export function defaultWorkspace(): string {
  const env = String(process.env.QIMING_WORKSPACE ?? '').trim();
  if (env) return env;
  for (const candidate of ['/media/leo/DATA/workspace', path.join(osHomeGuess(), 'workspace')]) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* 不存在就看下一个 */
    }
  }
  return osHomeGuess();
}

function osHomeGuess(): string {
  return process.env.HOME || '/';
}

export const DEFAULT_PARAMS: Required<
  Pick<ModelParams, 'temperature' | 'maxTokens' | 'callTimeoutSec' | 'retryCount' | 'ctxLimit' | 'stallSec' | 'autoContinue' | 'autoContinueMax'>
> = {
  temperature: 0.6,
  maxTokens: 8192,
  callTimeoutSec: 600,
  retryCount: 2,
  ctxLimit: 200_000,
  stallSec: 90,
  autoContinue: false,
  autoContinueMax: 2,
};

const EMPTY: Settings = {
  version: 1,
  providers: [],
  activeId: null,
  params: { ...DEFAULT_PARAMS, thinkingBudget: 0 },
  workspace: '',
  ui: {},
  updatedAt: 0,
};

export function readSettings(): Settings {
  const raw = readJson<Settings>(SETTINGS_FILE, EMPTY);
  return normalize(raw);
}

export function normalize(raw: Partial<Settings> | null | undefined): Settings {
  const cur = raw ?? {};
  const providers = Array.isArray(cur.providers) ? cur.providers.filter((p) => p && p.id) : [];
  const activeId = providers.some((p) => p.id === cur.activeId) ? (cur.activeId ?? null) : (providers[0]?.id ?? null);
  return {
    version: 1,
    providers,
    activeId,
    params: { ...DEFAULT_PARAMS, thinkingBudget: 0, ...(cur.params ?? {}) },
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
  if (typeof patch.workspace === 'string') next.workspace = patch.workspace.trim() || defaultWorkspace();
  if (patch.ui && typeof patch.ui === 'object') next.ui = { ...cur.ui, ...patch.ui };
  return saveSettings(next);
}

export function providerOf(settings: Settings, id?: string | null): Provider | null {
  const target = id ?? settings.activeId;
  return settings.providers.find((p) => p.id === target) ?? null;
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
