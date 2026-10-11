/**
 * src/modules/plugins/registry.ts —— 插件登记表。
 *
 * 把三类插件合成一份"当前生效"的清单：
 *   1. 内置插件（代码里定义，见 builtin/）
 *   2. 自定义插件（用户在界面上写：提示词 + 命令模板）
 *   3. 外部资源带来的工具（由 resources 模块注册，形态一致）
 *
 * 用户能改的三件事（都在 data/plugins.json）：启用/停用、用法提示词、参数值。
 * **参数没有服务端硬上限** —— 用户填多少就是多少（需求 8）；
 * 代码里只保留"没有配置时的默认值"。
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { readJson, readJsonStrict, writeJson } from '../../store/kv.ts';
import { PLUGINS_FILE, DOWNLOADS_DIR } from '../../util/paths.ts';
import { prompts } from '../prompts/registry.ts';
import type { ParamDef, PluginDef, Tool, ToolRunCtx } from './types.ts';
import { fsPlugin, fsTools } from './builtin/fs.ts';
import { execPlugin, execTools } from './builtin/exec.ts';
import { waitPlugin, deliverPlugin, todoPlugin, searchPlugin } from './builtin/misc.ts';
import { memoryPlugin } from './builtin/memory-tools.ts';
import { skillPlugin } from './builtin/skill-tools.ts';
import { subagentPlugin } from './builtin/subagent.ts';
import { mediaPlugin } from './builtin/media.ts';
import { changesPlugin } from './builtin/changes.ts';

export type CustomToolDef = {
  name: string;
  desc: string;
  /** JSON Schema（object）；界面里可以直接贴 */
  schema: Record<string, unknown>;
  /** 命令模板：`{arg}` 会被替换成 shell 安全转义的参数值 */
  command: string;
  /** stdin: 'json' 时把参数 JSON 从标准输入喂进去（适合参数多的命令） */
  stdin?: 'json' | 'none';
};

export type CustomPluginDef = {
  id: string;
  name: string;
  desc: string;
  prompt: string;
  enabled: boolean;
  params: ParamDef[];
  tools: CustomToolDef[];
};

type Overrides = {
  version: number;
  /** 只管"启停 + 参数"；提示词一律在 prompts.json（单一真源，见 setOverride） */
  overrides: Record<string, { enabled?: boolean; params?: Record<string, unknown> }>;
  custom: CustomPluginDef[];
  updatedAt: number;
};

const EMPTY: Overrides = { version: 1, overrides: {}, custom: [], updatedAt: 0 };

export type PluginView = {
  id: string;
  name: string;
  desc: string;
  builtin: boolean;
  enabled: boolean;
  prompt: string;
  defaultPrompt: string;
  params: Array<ParamDef & { value: unknown }>;
  tools: Array<{ name: string; desc: string; schema: Record<string, unknown> }>;
  /** 自定义插件的原始定义（界面编辑用） */
  raw?: CustomPluginDef;
};

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function customTools(def: CustomPluginDef): Tool[] {
  return def.tools.map((t) => ({
    name: t.name,
    pluginId: def.id,
    description: t.desc,
    desc: () => prompts.text(`tool.${t.name}.desc`) || t.desc,
    schema: t.schema ?? { type: 'object', properties: {}, additionalProperties: true },
    run: async (args: Record<string, unknown>, ctx: ToolRunCtx) => {
      let command = t.command;
      for (const [k, v] of Object.entries(args ?? {})) {
        const rendered = typeof v === 'string' ? v : JSON.stringify(v);
        command = command.split(`{${k}}`).join(shellQuote(String(rendered)));
      }
      const timeoutSec = Number(ctx.param('timeout_sec') ?? 300) || 300;
      const res = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn('bash', ['-lc', command], {
          cwd: ctx.cwd,
          env: { ...process.env, QIMING_RUN_ID: ctx.runId, QIMING_SESSION_ID: ctx.sessionId },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const outs: Buffer[] = [];
        const errs: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => outs.push(c));
        child.stderr.on('data', (c: Buffer) => errs.push(c));
        const kill = () => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            /* 已退出 */
          }
        };
        const timer = setTimeout(kill, timeoutSec * 1000);
        ctx.signal.addEventListener('abort', kill, { once: true });
        if (t.stdin === 'json') child.stdin.end(JSON.stringify(args ?? {}));
        else child.stdin.end();
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, out: Buffer.concat(outs).toString('utf8'), err: Buffer.concat(errs).toString('utf8') });
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ code: null, out: '', err: err.message });
        });
      });
      const text = [res.out.trim(), res.err.trim() && `--- stderr ---\n${res.err.trim()}`, `--- 退出码 ${res.code}`]
        .filter(Boolean)
        .join('\n');
      return { ok: res.code === 0, text: text || '（命令没有输出）', note: res.code === 0 ? 'ok' : `退出码 ${res.code}` };
    },
  }));
}

/**
 * 首次运行种一份**带示例**的 plugins.json。
 * 为什么带示例：agent 要"直接改文件来新增插件"（需求 3），而"照抄现成的一份再改"
 * 比照着文档手写可靠得多 —— 示例默认停用，不干扰正常使用。
 */
function seedStore(): Overrides {
  const seeded: Overrides = {
    version: 1,
    overrides: {},
    custom: [
      {
        id: 'example-echo',
        name: '示例插件（可照抄）',
        desc: '演示自定义插件的字段：提示词 + 命令模板工具。默认停用，复制一份改成自己的再启用。',
        prompt:
          '示例插件：example_echo(text)。把 text 原样回显 —— 用它看清自定义插件的写法（命令模板里的 {参数名} 会被 shell 转义后替换）。',
        enabled: false,
        params: [{ key: 'prefix', name: '前缀', type: 'string', def: '回显：' }],
        tools: [
          {
            name: 'example_echo',
            desc: '把输入原样回显（演示用）',
            schema: {
              type: 'object',
              properties: { text: { type: 'string', description: '要回显的内容' } },
              required: ['text'],
              additionalProperties: false,
            },
            command: "printf '回显：%s\\n' {text}",
            stdin: 'none',
          },
        ],
      },
    ],
    updatedAt: 0,
  };
  writeJson(PLUGINS_FILE, seeded);
  return seeded;
}

export function createPluginRegistry() {
  let store: Overrides = fs.existsSync(PLUGINS_FILE)
    ? readJson<Overrides>(PLUGINS_FILE, EMPTY)
    : seedStore();
  if (!store || typeof store !== 'object') store = { ...EMPTY };
  store.overrides ??= {};
  store.custom ??= [];

  /** 内置插件定义（工具在这里构造一次） */
  const builtins: PluginDef[] = [
    { ...fsPlugin, tools: fsTools() },
    { ...changesPlugin },
    { ...execPlugin, tools: execTools() },
    { ...waitPlugin },
    { ...deliverPlugin },
    { ...mediaPlugin },
    { ...todoPlugin },
    { ...searchPlugin },
    { ...memoryPlugin },
    { ...skillPlugin },
    { ...subagentPlugin },
  ];

  /** 外部资源注册的工具（按资源 id 成"插件"） */
  const external: PluginDef[] = [];

  function defs(): PluginDef[] {
    return [
      ...builtins,
      ...external,
      ...store.custom.map(
        (c): PluginDef => ({
          id: c.id,
          name: c.name,
          desc: c.desc,
          builtin: false,
          promptId: `plugin.${c.id}.usage`,
          prompt: c.prompt,
          params: c.params ?? [],
          tools: customTools(c),
        }),
      ),
    ];
  }

  /** 把插件与工具的提示词注册进提示词中心（默认值来自代码；用户覆盖另存 prompts.json） */
  function syncPromptDefs(): void {
    const own = defs().filter((p) => !p.external);
    prompts.register(
      own.map((p) => ({
        id: p.promptId,
        group: `plugin:${p.id}`,
        name: `插件用法：${p.name}`,
        text: p.prompt,
        toggleable: false,
      })),
    );
    for (const p of own) {
      prompts.register(
        p.tools.map((t) => ({
          id: `tool.${t.name}.desc`,
          group: `plugin:${p.id}`,
          name: `工具描述：${t.name}`,
          text: t.description,
          toggleable: false,
        })),
      );
    }
  }

  function enabledOf(id: string): boolean {
    const ov = store.overrides[id];
    if (ov && typeof ov.enabled === 'boolean') return ov.enabled;
    return true;
  }

  function paramsOf(id: string): Record<string, unknown> {
    const def = defs().find((p) => p.id === id);
    // 外部资源的参数存在 resources.json（谁的东西谁管，避免两处各存一份）
    if (def?.readParams) return def.readParams();
    const out: Record<string, unknown> = {};
    for (const p of def?.params ?? []) out[p.key] = p.def;
    const ov = store.overrides[id]?.params;
    if (ov && typeof ov === 'object') Object.assign(out, ov);
    return out;
  }

  /** 生效工具表：启用的插件 × 它们的工具；工具描述走提示词中心 */
  function tools(): Tool[] {
    const out: Tool[] = [];
    for (const p of defs()) {
      if (!enabledOf(p.id)) continue;
      for (const t of p.tools) {
        out.push({
          ...t,
          desc: () => prompts.text(`tool.${t.name}.desc`) || t.description || '',
        });
      }
    }
    return out;
  }

  function toolByName(name: string): Tool | null {
    return tools().find((t) => t.name === name) ?? null;
  }

  function pluginOfTool(name: string): PluginDef | null {
    return defs().find((p) => p.tools.some((t) => t.name === name)) ?? null;
  }

  /** 界面上的「插件」= 内置 + 自定义；外部资源的工具由资源页展示（需求 1） */
  function views(): PluginView[] {
    return defs()
      .filter((p) => !p.external)
      .map((p) => ({
      id: p.id,
      name: p.name,
      desc: p.desc,
      builtin: p.builtin,
      enabled: enabledOf(p.id),
      prompt: prompts.text(p.promptId),
      defaultPrompt: p.prompt,
      params: p.params.map((d) => ({ ...d, value: paramsOf(p.id)[d.key] })),
        tools: p.tools.map((t) => ({ name: t.name, desc: t.desc?.() ?? t.description, schema: t.schema })),
        raw: store.custom.find((c) => c.id === p.id),
      }));
  }

  function save(next: Overrides): void {
    store = { version: 1, overrides: next.overrides ?? {}, custom: next.custom ?? [], updatedAt: Date.now() };
    writeJson(PLUGINS_FILE, store);
    syncPromptDefs();
  }

  /**
   * 启停 / 参数 / 用法提示词。
   * 提示词**只写 prompts.json**（prompts.set）—— 插件页与提示词页改的是同一条记录，
   * 因此两边看到的、生效的完全一致（需求 2 的"数据归一化"）。
   */
  function setOverride(id: string, patch: { enabled?: boolean; prompt?: string; params?: Record<string, unknown> }): void {
    const def = defs().find((p) => p.id === id);
    if (typeof patch.enabled === 'boolean' || patch.params) {
      const cur = store.overrides[id] ?? {};
      const next = { ...cur };
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
      if (patch.params) next.params = { ...(cur.params ?? {}), ...patch.params };
      save({ ...store, overrides: { ...store.overrides, [id]: next } });
    }
    if (patch.prompt !== undefined && def) prompts.set(def.promptId, { text: patch.prompt });
  }

  /** 热重载：agent 直接改 plugins.json 后由文件监听触发（不重启服务） */
  function reload(): boolean {
    const next = readJsonStrict<Overrides>(PLUGINS_FILE);
    if (!next || typeof next !== 'object' || !next.overrides || typeof next.overrides !== 'object') return false;
    store = { version: 1, overrides: next.overrides, custom: Array.isArray(next.custom) ? next.custom : [], updatedAt: next.updatedAt ?? 0 };
    syncPromptDefs();
    return true;
  }

  function upsertCustom(def: CustomPluginDef): void {
    const custom = store.custom.slice();
    const i = custom.findIndex((c) => c.id === def.id);
    if (i >= 0) custom[i] = def;
    else custom.push(def);
    save({ ...store, custom });
  }

  function removeCustom(id: string): void {
    save({ ...store, custom: store.custom.filter((c) => c.id !== id) });
  }

  /** 外部资源模块用它把资源工具挂进来（同名资源重复注册时后写覆盖） */
  function registerExternal(def: PluginDef): void {
    const i = external.findIndex((p) => p.id === def.id);
    if (i >= 0) external[i] = def;
    else external.push(def);
  }
  function clearExternal(): void {
    external.length = 0;
  }

  return {
    syncPromptDefs,
    reload,
    tools,
    toolByName,
    pluginOfTool,
    views,
    setOverride,
    upsertCustom,
    removeCustom,
    registerExternal,
    clearExternal,
    paramsOf,
    enabledOf,
    defs,
    /** 供外部资源登记表把自己标成 external 后重新登记 */
    rawStore: () => store,
    dirForDownloads: () => DOWNLOADS_DIR,
    fs,
  };
}

export type PluginRegistry = ReturnType<typeof createPluginRegistry>;
