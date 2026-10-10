/**
 * src/modules/prompts/registry.ts —— 提示词注册中心。
 *
 * 唯一职责：把"代码里的默认文本"与"用户在界面上改过的文本"合成一份**当前生效文本**，
 * 并让四个模块（插件/记忆/技能/资源）都能把自己的条目注册进来、界面上可读可写。
 *
 * 设计要点：
 *  - 条目按 group 归属模块，界面上"插件/记忆/技能"页各看自己那组；改任何一条都走同一个通道。
 *  - 覆盖存在 data/prompts.json：`{ overrides: { <id>: { text?, enabled? } } }`。
 *  - 改完立刻生效：下一次系统提示词组装就会用新文本（运行中的会话下一轮也生效）。
 *  - 支持 {name} 占位：由使用方传 vars 渲染，注册中心不做业务替换。
 */
import { corePromptDefs } from './defaults.ts';
import fs from 'node:fs';
import { readJson, readJsonStrict, writeJson } from '../../store/kv.ts';
import { PROMPTS_FILE } from '../../util/paths.ts';

export type PromptDef = {
  id: string;
  group: string;
  name: string;
  text: string;
  /** 用户可编辑（工具描述等也是可编辑的；个别想锁死的条目设 false） */
  editable?: boolean;
  /** 默认是否启用（技能/插件提示词可被停用） */
  enabled?: boolean;
  /** 停用后是否还能被别处引用（例如工具 schema 描述不能被停用） */
  toggleable?: boolean;
};

export type PromptEntry = PromptDef & {
  defaultText: string;
  text: string; // 生效文本
  changed: boolean;
};

type Store = {
  version: number;
  overrides: Record<string, { text?: string; enabled?: boolean }>;
  updatedAt?: number;
};

const EMPTY: Store = { version: 1, overrides: {} };

export function createPromptRegistry() {
  const defs = new Map<string, PromptDef>();
  if (!fs.existsSync(PROMPTS_FILE)) writeJson(PROMPTS_FILE, EMPTY); // 种一份空结构，便于"读-改-写"
  let store: Store = readJson<Store>(PROMPTS_FILE, EMPTY);
  if (!store || typeof store !== 'object' || typeof store.overrides !== 'object' || !store.overrides) {
    store = { ...EMPTY };
  }
  const listeners = new Set<() => void>();

  function register(list: PromptDef[]): void {
    for (const def of list) {
      if (!def?.id) continue;
      defs.set(def.id, { editable: true, toggleable: false, enabled: true, ...def, text: def.text ?? '' });
    }
    notify();
  }

  /** 动态条目（如外部资源）每次重建：先移除旧组再注册新组 */
  function replaceGroup(group: string, list: PromptDef[]): void {
    for (const [id, def] of defs) if (def.group === group) defs.delete(id);
    register(list);
  }

  function raw(id: string): string {
    const def = defs.get(id);
    if (!def) return '';
    const ov = store.overrides[id];
    return typeof ov?.text === 'string' ? ov.text : def.text;
  }

  function enabled(id: string): boolean {
    const def = defs.get(id);
    if (!def) return false;
    const ov = store.overrides[id];
    if (typeof ov?.enabled === 'boolean') return ov.enabled;
    return def.enabled !== false;
  }

  /** 渲染 {var} 占位；未提供的变量原样保留（便于用户看出漏了什么） */
  function text(id: string, vars?: Record<string, string>): string {
    const t = raw(id);
    if (!vars) return t;
    return t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  }

  function list(): PromptEntry[] {
    return [...defs.values()].map((def) => {
      const ov = store.overrides[def.id];
      const changed = typeof ov?.text === 'string' && ov.text !== def.text;
      return {
        ...def,
        defaultText: def.text,
        text: raw(def.id),
        enabled: enabled(def.id),
        changed,
      };
    });
  }

  function set(id: string, patch: { text?: string; enabled?: boolean }): PromptEntry | null {
    const def = defs.get(id);
    if (!def) return null;
    const cur = store.overrides[id] ?? {};
    const next = { ...cur };
    if (typeof patch.text === 'string') next.text = patch.text;
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    // 与默认完全一致时不留覆盖，保持文件干净
    if (next.text === def.text) delete next.text;
    if (next.enabled === undefined || next.enabled === (def.enabled !== false)) delete next.enabled;
    const overrides = { ...store.overrides };
    if (Object.keys(next).length === 0) delete overrides[id];
    else overrides[id] = next;
    store = { ...store, overrides, updatedAt: Date.now() };
    writeJson(PROMPTS_FILE, store);
    notify();
    return list().find((e) => e.id === id) ?? null;
  }

  function reset(id: string): PromptEntry | null {
    return set(id, { text: defs.get(id)?.text ?? '', enabled: defs.get(id)?.enabled !== false });
  }

  /** 热重载：agent 直接改 prompts.json 后由文件监听触发（默认值仍在代码里，这里只换覆盖） */
  function reload(): boolean {
    const next = readJsonStrict<Store>(PROMPTS_FILE);
    if (!next || typeof next !== 'object' || typeof next.overrides !== 'object' || !next.overrides) return false;
    store = { version: 1, overrides: next.overrides, updatedAt: next.updatedAt ?? 0 };
    notify();
    return true;
  }

  function onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function notify(): void {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* 订阅者出错不影响注册中心 */
      }
    }
  }

  return { register, replaceGroup, text, raw, enabled, list, set, reset, reload, onChange };
}

export type PromptRegistry = ReturnType<typeof createPromptRegistry>;

/** 单例：全进程一份（server.ts 启动时 register corePromptDefs()） */
export const prompts: PromptRegistry = createPromptRegistry();
export { corePromptDefs };
