/**
 * src/modules/resources/index.ts —— 外部资源模块。
 *
 * 「外部资源」= 本机可调用的外部能力（ComfyUI、浏览器自动化、屏幕操作、任何 MCP 服务器…）。
 * 三种接入形态：
 *   mcp     stdio MCP 服务器 —— 工具由服务器自报（tools/list），这里缓存后暴露给模型
 *   http    声明式 HTTP 端点 —— 每个 action 一条工具（如 ComfyUI 的 /prompt、/history）
 *   command 本地命令模板 —— 参数 JSON 从 stdin 进、结果从 stdout 出（如 browser-use 封装）
 *
 * 与插件的分工：外部资源的工具会**以插件形态**注册进插件登记表（启用/停用、参数、提示词都在同一处），
 * 界面上却单独有一个「外部资源」页 —— 因为用户关心的是"我接了哪些外部能力、它们通不通"。
 *
 * 每个资源的说明文本（desc）会注入系统提示词，让模型知道"这台机器上还有什么可以调用"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson, readJsonStrict, writeJson, now } from '../../store/kv.ts';
import { RESOURCES_FILE, ROOT, DOWNLOADS_DIR, DATA_ROOT } from '../../util/paths.ts';
import { prompts } from '../prompts/registry.ts';
import { McpClient, type McpTool } from './mcp.ts';
import type { PluginDef, Tool, ToolRunCtx } from '../plugins/types.ts';

export type ResourceKind = 'mcp' | 'http' | 'command';

export type HttpParam = {
  key: string;
  in: 'query' | 'body' | 'path';
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  desc?: string;
  required?: boolean;
};

export type HttpAction = {
  name: string;
  desc: string;
  method: 'GET' | 'POST';
  path: string;
  params?: HttpParam[];
  /** 有它就把响应体存进待下载目录（二进制结果，如 ComfyUI 出的图） */
  saveAs?: string;
  /** 结果截断（毫秒） */
  timeoutSec?: number;
};

export type CommandTool = {
  name: string;
  desc: string;
  schema: Record<string, unknown>;
  command: string;
  stdin?: 'json' | 'none';
  timeoutSec?: number;
};

export type Resource = {
  id: string;
  name: string;
  kind: ResourceKind;
  desc: string;
  enabled: boolean;
  /** mcp / command：启动命令 */
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** http */
  baseUrl?: string;
  headers?: Record<string, string>;
  actions?: HttpAction[];
  /** command */
  tools?: CommandTool[];
  /** 该资源自己的参数定义（默认只有"单次调用超时"） */
  paramDefs?: Array<{ key: string; name: string; type: 'number' | 'string' | 'boolean'; def: unknown; desc?: string }>;
  /** 参数值：存在资源自己这里（谁的东西谁管，别和 plugins.json 两处各存一份） */
  params?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

/** 资源默认参数：调用超时（秒） */
export const DEFAULT_RESOURCE_PARAMS = [
  { key: 'timeout_sec', name: '单次调用超时（秒）', type: 'number' as const, def: 300 },
];

type Store = { version: number; resources: Resource[]; updatedAt: number };
const EMPTY: Store = { version: 1, resources: [], updatedAt: 0 };

export type ResourceStatus = {
  id: string;
  state: 'idle' | 'ready' | 'error';
  detail: string;
  tools: number;
  serverInfo?: { name?: string; version?: string };
};

/** 内置预置：首次运行seed；用户可以改、可以删 */
export function presetResources(): Resource[] {
  const t = now();
  return [
    {
      id: 'comfyui',
      name: 'ComfyUI（生图/工作流）',
      kind: 'http',
      desc: '本机 ComfyUI 服务（默认 http://127.0.0.1:8188）。用它跑工作流出图/出视频：先 comfyui_queue 提交工作流（JSON），再用 comfyui_history 查状态，最后 comfyui_fetch 把产物存到待下载目录。工作流 JSON 可以从用户给的文件或 /object_info 里拼。',
      enabled: true,
      baseUrl: 'http://127.0.0.1:8188',
      actions: [
        { name: 'comfyui_status', desc: '看服务是否在线、显存与队列情况', method: 'GET', path: '/system_stats', timeoutSec: 30 },
        { name: 'comfyui_queue', desc: '提交一个工作流（prompt JSON），返回 prompt_id', method: 'POST', path: '/prompt', params: [{ key: 'prompt', in: 'body', type: 'object', desc: '工作流 JSON（API 格式的 prompt）', required: true }], timeoutSec: 60 },
        { name: 'comfyui_history', desc: '按 prompt_id 查执行结果（含输出文件清单）', method: 'GET', path: '/history/{prompt_id}', params: [{ key: 'prompt_id', in: 'path', type: 'string', required: true }], timeoutSec: 60 },
        { name: 'comfyui_queue_list', desc: '看当前队列与正在跑的任务', method: 'GET', path: '/queue', timeoutSec: 30 },
        { name: 'comfyui_interrupt', desc: '打断当前任务', method: 'POST', path: '/interrupt', timeoutSec: 30 },
        { name: 'comfyui_fetch', desc: '把一个输出文件存到待下载目录（图片/视频会直接显示在会话里）', method: 'GET', path: '/view', params: [
          { key: 'filename', in: 'query', type: 'string', required: true },
          { key: 'subfolder', in: 'query', type: 'string' },
          { key: 'type', in: 'query', type: 'string', desc: 'output / input / temp' },
        ], saveAs: 'filename', timeoutSec: 120 },
      ],
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'screen',
      name: '屏幕操作（computer-use-linux）',
      kind: 'mcp',
      desc: 'Linux 桌面自动化：读无障碍树（AT-SPI）+ 截图 + 鼠标键盘 + 窗口管理，Wayland/X11 都能用。工具名以 screen_ 开头（screen_get_app_state 先看界面 → screen_click 按语义选择器点，坐标点击作为兜底）。适合操作本机桌面应用（文件管理器、浏览器手操、IDE 等）。',
      enabled: true,
      // 优先用已装好的二进制（快、不依赖网络）；没装才回落 npx
      command: 'export PATH="$HOME/.local/node/bin:$PATH"; command -v computer-use-linux >/dev/null 2>&1 && exec computer-use-linux mcp || exec npx -y @agent-sh/computer-use-linux mcp',
      createdAt: t,
      updatedAt: t,
    },
    {
      id: 'browser',
      name: '浏览器操作（browser-use）',
      kind: 'command',
      desc: '用 browser-use 跑浏览器任务（自动开独立浏览器、看页面、点击输入、取回结果）。适合网页操作：填表、抓取、比价、登录后操作。它的模型走本工程的服务商配置（见 resources/browser-use/README.md）。',
      enabled: true,
      command: '',
      tools: [
        {
          name: 'browser_task',
          desc: '交给 browser-use 一个自然语言任务，它自己开浏览器做完并汇报结果',
          schema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: '任务描述（目标 + 已知信息 + 期望输出）' },
              max_steps: { type: 'number', description: '最多几步（默认 50）' },
              headless: { type: 'boolean', description: '无头模式（默认 false，方便用户看）' },
            },
            required: ['task'],
            additionalProperties: false,
          },
          command: `cd ${ROOT}/resources/browser-use && ./.venv/bin/python run_task.py`,
          stdin: 'json',
          timeoutSec: 900,
        },
      ],
      createdAt: t,
      updatedAt: t,
    },
  ];
}

export function createResourceRegistry() {
  let store: Store = readJson<Store>(RESOURCES_FILE, EMPTY);
  if (!store || !Array.isArray(store.resources)) store = { ...EMPTY };
  if (!fs.existsSync(RESOURCES_FILE)) {
    store = { version: 1, resources: presetResources(), updatedAt: now() };
    writeJson(RESOURCES_FILE, store);
  }

  const clients = new Map<string, McpClient>();
  const mcpTools = new Map<string, McpTool[]>();
  const status = new Map<string, ResourceStatus>();

  function save(): void {
    store.updatedAt = now();
    writeJson(RESOURCES_FILE, store);
  }

  function list(): Resource[] {
    return store.resources;
  }
  function get(id: string): Resource | null {
    return store.resources.find((r) => r.id === id) ?? null;
  }

  function toolName(res: Resource, raw: string): string {
    const rid = res.id.replace(/[^A-Za-z0-9_]/g, '_');
    const clean = raw.replace(/[^A-Za-z0-9_]/g, '_');
    // 动作名自带资源前缀（comfyui_status）就不要再叠一层
    return (clean.startsWith(`${rid}_`) ? clean : `${rid}_${clean}`).replace(/_+/g, '_');
  }

  /* ────────────────────────── 工具构造 ────────────────────────── */

  function httpTools(res: Resource): Tool[] {
    const base = (res.baseUrl ?? '').replace(/\/$/, '');
    return (res.actions ?? []).map((action) => ({
      name: toolName(res, action.name),
      pluginId: res.id,
      description: action.desc,
      schema: {
        type: 'object',
        properties: Object.fromEntries(
          (action.params ?? []).map((p) => [
            p.key,
            { type: p.type === 'object' || p.type === 'array' ? (p.type === 'object' ? 'object' : 'array') : p.type, description: p.desc ?? '' },
          ]),
        ),
        required: (action.params ?? []).filter((p) => p.required).map((p) => p.key),
        additionalProperties: false,
      },
      run: async (args: Record<string, unknown>, ctx: ToolRunCtx) => {
        let url = `${base}${action.path}`;
        const query = new URLSearchParams();
        const body: Record<string, unknown> = {};
        for (const p of action.params ?? []) {
          const v = args[p.key];
          if (v === undefined || v === null) continue;
          if (p.in === 'path') url = url.replace(`{${p.key}}`, encodeURIComponent(String(v)));
          else if (p.in === 'query') query.set(p.key, typeof v === 'string' ? v : JSON.stringify(v));
          else body[p.key] = v;
        }
        if (query.size) url += `?${query.toString()}`;
        const timeoutMs = (action.timeoutSec ?? 120) * 1000;
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const resp = await fetch(url, {
            method: action.method,
            headers: { 'content-type': 'application/json', ...(res.headers ?? {}) },
            body: action.method === 'POST' ? JSON.stringify(body) : undefined,
            signal: ac.signal,
          });
          if (action.saveAs) {
            if (!resp.ok) return { ok: false, text: `${action.name} 失败：HTTP ${resp.status}` };
            fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
            const suggested = String(args[action.saveAs] ?? path.basename(new URL(url).pathname) ?? 'download');
            const dest = path.join(DOWNLOADS_DIR, path.basename(suggested));
            const buf = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(dest, buf);
            return {
              ok: true,
              text: `已保存到待下载目录：${path.basename(dest)}（${(buf.length / 1024).toFixed(1)} KB）`,
              note: `取回 ${path.basename(dest)}`,
              files: [dest],
            };
          }
          const text = await resp.text();
          const clipped = text.length > 60_000 ? `${text.slice(0, 60_000)}\n…（已截断，共 ${text.length} 字）` : text;
          return { ok: resp.ok, text: `HTTP ${resp.status}\n${clipped}`, note: `HTTP ${resp.status}` };
        } catch (err) {
          return { ok: false, text: `${action.name} 请求失败：${err instanceof Error ? err.message : String(err)}（服务地址 ${base}，确认它开着）` };
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
        }
      },
    }));
  }

  function commandTools(res: Resource): Tool[] {
    return (res.tools ?? []).map((def) => ({
      name: toolName(res, def.name),
      pluginId: res.id,
      description: def.desc,
      schema: def.schema,
      run: async (args: Record<string, unknown>, ctx: ToolRunCtx) => {
        const timeoutSec = def.timeoutSec ?? 300;
        const payload = JSON.stringify(args ?? {});
        const res2 = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
          const child = spawn('bash', ['-lc', def.command], {
            cwd: res.cwd ? path.resolve(res.cwd) : ROOT,
            env: { ...process.env, ...(res.env ?? {}), QIMING_RUN_ID: ctx.runId },
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
          if (def.stdin === 'json') child.stdin.end(payload);
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
        const parts = [res2.out.trim()];
        if (res2.err.trim()) parts.push(`--- stderr ---\n${res2.err.trim().slice(0, 4000)}`);
        parts.push(`--- 退出码 ${res2.code}`);
        return { ok: res2.code === 0, text: parts.filter(Boolean).join('\n\n'), note: res2.code === 0 ? 'ok' : `退出码 ${res2.code}` };
      },
    }));
  }

  function mcpToolsOf(res: Resource): Tool[] {
    const cached = mcpTools.get(res.id) ?? [];
    return cached.map((t) => ({
      name: toolName(res, t.name),
      pluginId: res.id,
      description: t.description || t.name,
      schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      run: async (args: Record<string, unknown>, ctx: ToolRunCtx) => {
        const client = clients.get(res.id);
        if (!client) return { ok: false, text: `${res.name} 未连接。到「外部资源」页点"测试连接"重连。` };
        const timeoutMs = Math.max(30, Number(ctx.param('timeout_sec') ?? 300)) * 1000;
        try {
          const out = await client.callTool(t.name, args ?? {}, timeoutMs);
          return { ok: out.ok, text: out.text, note: out.ok ? t.name : `${t.name} 失败`, ...(out.images.length ? { images: out.images } : {}) };
        } catch (err) {
          return { ok: false, text: `${res.name}.${t.name} 调用失败：${err instanceof Error ? err.message : String(err)}` };
        }
      },
    }));
  }

  /** 生效工具：启用的资源 × 各自工具 */
  function isEnabled(id: string): boolean {
    const r = get(id);
    return Boolean(r?.enabled);
  }

  function pluginDefs(): PluginDef[] {
    return store.resources
      .filter((r) => r.enabled)
      .map((res) => ({
        id: res.id,
        name: res.name,
        desc: res.desc,
        builtin: false,
        // external：界面上归「外部资源」页；工具仍然进模型工具表（这才是"能调用"）
        external: true,
        readParams: () => paramsOf(res.id),
        promptId: `res.${res.id}.usage`,
        prompt: res.desc,
        params: res.paramDefs ?? DEFAULT_RESOURCE_PARAMS,
        tools: res.kind === 'mcp' ? mcpToolsOf(res) : res.kind === 'http' ? httpTools(res) : commandTools(res),
      }));
  }

  /** 参数：默认值 + 资源里存的值 */
  function paramsOf(id: string): Record<string, unknown> {
    const res = get(id);
    const out: Record<string, unknown> = {};
    for (const p of res?.paramDefs ?? DEFAULT_RESOURCE_PARAMS) out[p.key] = p.def;
    Object.assign(out, res?.params ?? {});
    return out;
  }

  function setParams(id: string, patch: Record<string, unknown>): void {
    const res = get(id);
    if (!res) return;
    res.params = { ...(res.params ?? {}), ...patch };
    res.updatedAt = now();
    save();
  }

  /**
   * 工具定义一变（连接、断开、改配置），就要把提示词条目与插件表刷新一遍。
   * 条目 id：`res.<资源id>.usage`（资源说明）+ `tool.<工具名>.desc`（每个工具的描述），
   * 都归到 `res:<资源id>` 组 —— 这样提示词页能按"这条属于哪个资源"分组，
   * 资源页也能只列自己的条目；两边改的是同一条记录（需求 2）。
   */
  function refresh(): void {
    prompts.register(
      store.resources.map((r) => ({
        id: `res.${r.id}.usage`,
        group: `res:${r.id}`,
        name: `资源用法：${r.name}`,
        text: r.desc,
        toggleable: false,
      })),
    );
    for (const def of pluginDefs()) {
      prompts.register(
        def.tools.map((t) => ({
          id: `tool.${t.name}.desc`,
          group: `res:${def.id}`,
          name: `工具描述：${t.name}`,
          text: t.description,
          toggleable: false,
        })),
      );
    }
  }

  /** 热重载：agent 直接改 resources.json 后由文件监听触发 */
  function reload(): boolean {
    const next = readJsonStrict<Store>(RESOURCES_FILE);
    if (!next || !Array.isArray(next.resources)) return false;
    const before = new Set(store.resources.map((r) => r.id));
    store = { version: 1, resources: next.resources, updatedAt: next.updatedAt ?? 0 };
    // 连接管理：新增的 mcp 资源连上，删掉的断开
    for (const r of store.resources) {
      if (r.kind === 'mcp' && r.enabled && !before.has(r.id)) void connect(r.id);
    }
    for (const [id, client] of clients) {
      if (!store.resources.some((r) => r.id === id && r.enabled)) {
        client.stop();
        clients.delete(id);
        mcpTools.delete(id);
      }
    }
    refresh();
    onToolsChanged?.();
    return true;
  }

  /* ────────────────────────── 连接与状态 ────────────────────────── */

  async function connect(id: string): Promise<ResourceStatus> {
    const res = get(id);
    if (!res) return { id, state: 'error', detail: '资源不存在', tools: 0 };
    if (res.kind !== 'mcp') {
      const st: ResourceStatus = {
        id,
        state: 'ready',
        detail: res.kind === 'http' ? `HTTP 端点：${res.baseUrl ?? '（未填）'}` : `本地命令：${(res.tools ?? []).length} 个工具`,
        tools: res.kind === 'http' ? (res.actions ?? []).length : (res.tools ?? []).length,
      };
      status.set(id, st);
      return st;
    }
    const old = clients.get(id);
    if (old) {
      old.stop();
      clients.delete(id);
    }
    const client = new McpClient({ id: res.id, command: res.command ?? '', env: res.env, cwd: res.cwd });
    clients.set(id, client);
    try {
      const tools = await client.listTools(true);
      mcpTools.set(id, tools);
      const st: ResourceStatus = {
        id,
        state: 'ready',
        detail: `${client.serverInfo.name ?? '?'} ${client.serverInfo.version ?? ''} · ${tools.length} 个工具`,
        tools: tools.length,
        serverInfo: client.serverInfo,
      };
      status.set(id, st);
      // 有状态插件：工具表变了，插件登记表要重新读
      onToolsChanged?.();
      return st;
    } catch (err) {
      const st: ResourceStatus = { id, state: 'error', detail: err instanceof Error ? err.message : String(err), tools: 0 };
      status.set(id, st);
      client.stop();
      clients.delete(id);
      mcpTools.set(id, []);
      onToolsChanged?.();
      return st;
    }
  }

  let onToolsChanged: (() => void) | null = null;
  function setToolsChangedHook(fn: () => void): void {
    onToolsChanged = fn;
  }

  /** 启动时把启用的 MCP 资源连上（失败不阻塞服务启动） */
  async function startEnabled(): Promise<void> {
    for (const res of store.resources) {
      if (!res.enabled || res.kind !== 'mcp') continue;
      void connect(res.id);
    }
  }

  function stopAll(): void {
    for (const [, c] of clients) c.stop();
    clients.clear();
  }

  function upsert(input: Resource): Resource {
    const old = store.resources.find((r) => r.id === input.id);
    const next: Resource = {
      ...input,
      // 界面上没展开的字段别被顺手清空（旧项目"空快照抹配置"的教训）
      params: input.params ?? old?.params,
      paramDefs: input.paramDefs ?? old?.paramDefs,
      env: input.env ?? old?.env,
      headers: input.headers ?? old?.headers,
      updatedAt: now(),
      createdAt: input.createdAt || old?.createdAt || now(),
    };
    const i = store.resources.findIndex((r) => r.id === next.id);
    if (i >= 0) store.resources[i] = next;
    else store.resources.push(next);
    save();
    refresh();
    if (next.kind === 'mcp' && next.enabled) void connect(next.id);
    onToolsChanged?.();
    return next;
  }

  function remove(id: string): boolean {
    const i = store.resources.findIndex((r) => r.id === id);
    if (i < 0) return false;
    store.resources.splice(i, 1);
    save();
    clients.get(id)?.stop();
    clients.delete(id);
    mcpTools.delete(id);
    refresh();
    onToolsChanged?.();
    return true;
  }

  function setEnabled(id: string, enabled: boolean): Resource | null {
    const res = get(id);
    if (!res) return null;
    res.enabled = enabled;
    res.updatedAt = now();
    save();
    if (enabled && res.kind === 'mcp') void connect(id);
    else if (!enabled && res.kind === 'mcp') {
      clients.get(id)?.stop();
      clients.delete(id);
    }
    onToolsChanged?.();
    return res;
  }

  function views() {
    return store.resources.map((r) => ({
      ...r,
      params: paramsOf(r.id),
      paramDefs: r.paramDefs ?? DEFAULT_RESOURCE_PARAMS,
      prompt: prompts.text(`res.${r.id}.usage`),
      defaultPrompt: r.desc,
      status: status.get(r.id) ?? { id: r.id, state: 'idle' as const, detail: '未连接', tools: r.kind === 'mcp' ? 0 : (r.actions?.length ?? r.tools?.length ?? 0) },
      toolList:
        r.kind === 'mcp'
          ? (mcpTools.get(r.id) ?? []).map((t) => ({ name: toolName(r, t.name), desc: t.description }))
          : r.kind === 'http'
            ? (r.actions ?? []).map((a) => ({ name: toolName(r, a.name), desc: a.desc }))
            : (r.tools ?? []).map((t) => ({ name: toolName(r, t.name), desc: t.desc })),
    }));
  }

  return {
    list, get, views, upsert, remove, setEnabled, connect, startEnabled, stopAll,
    pluginDefs, refresh, reload, setParams, paramsOf, setToolsChangedHook, isEnabled,
  };
}

export type ResourceRegistry = ReturnType<typeof createResourceRegistry>;
export { DATA_ROOT };
