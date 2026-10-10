/**
 * src/modules/resources/mcp.ts —— 最小 MCP 客户端（stdio 传输）。
 *
 * 为什么自己写而不引 SDK：MCP 的 stdio 传输就是"一行一个 JSON-RPC"，需要的能力只有三个
 * （initialize / tools/list / tools/call），~200 行足够；引 SDK 会带来一坨依赖和版本漂移。
 *
 * 分工：连接由资源登记表持有（懒启动 + 空闲回收），这里只负责"说清楚一次会话"。
 * 三个实测要点：
 *  1. 有些服务器（如 Rust 写的）启动需要几百毫秒到几秒，initialize 要有超时；
 *  2. stderr 是服务器日志，必须转发出来，否则连不上时无从排查；
 *  3. 子进程必须能被整组杀掉，否则退出后残留进程会占住浏览器/合成器连接。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../../util/log.ts';

const log = logger('mcp');
const PROTOCOL_VERSION = '2025-06-18';
const INIT_TIMEOUT = 60_000;

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpClient {
  private child: ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private starting: Promise<void> | null = null;
  private tools: McpTool[] = [];
  private closing = false;
  /** 服务器信息（initialize 的返回，界面上有用） */
  serverInfo: { name?: string; version?: string } = {};

  private readonly opts: { id: string; command: string; env?: Record<string, string>; cwd?: string };

  constructor(opts: { id: string; command: string; env?: Record<string, string>; cwd?: string }) {
    this.opts = opts;
  }

  get running(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  async ensure(): Promise<void> {
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    log.info(`启动 MCP 资源 ${this.opts.id}`, { command: this.opts.command });
    const child = spawn('bash', ['-lc', this.opts.command], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.child = child;
    this.buf = '';
    child.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr!.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) log.debug(`[${this.opts.id}] ${line.slice(0, 500)}`);
    });
    child.on('exit', (code, sig) => {
      log.warn(`MCP 资源 ${this.opts.id} 退出`, { code, sig });
      this.failAll(new Error(`MCP 服务已退出（code=${code ?? 'null'}${sig ? `, signal=${sig}` : ''}）`));
      this.child = null;
    });
    child.on('error', (err) => {
      log.error(`MCP 资源 ${this.opts.id} 启动失败`, { err: String(err) });
      this.failAll(err);
      this.child = null;
    });

    const init = (await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'qiming', version: '0.1.0' },
      },
      INIT_TIMEOUT,
    )) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = init?.serverInfo ?? {};
    this.notify('notifications/initialized', {});
    this.tools = [];
    log.info(`MCP 资源 ${this.opts.id} 就绪`, this.serverInfo);
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log.debug(`[${this.opts.id}] 非 JSON 输出：${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : null;
    if (id === null) return; // 通知/请求（服务器发来的），忽略
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const e = msg.error as { message?: string; code?: number };
      pending.reject(new Error(`${e.message ?? 'MCP 错误'}（code ${e.code ?? '?'}）`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private send(obj: unknown): void {
    if (!this.child?.stdin?.writable) throw new Error('MCP 服务未在运行');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: '2.0', method, params });
    } catch {
      /* 通知失败不致命 */
    }
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 调用超时（${method}，${timeoutMs / 1000}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async listTools(force = false): Promise<McpTool[]> {
    await this.ensure();
    if (this.tools.length && !force) return this.tools;
    const res = (await this.request('tools/list', {}, 30_000)) as { tools?: unknown[] };
    this.tools = (res?.tools ?? []).map((t) => {
      const obj = t as Record<string, unknown>;
      return {
        name: String(obj.name ?? ''),
        description: String(obj.description ?? ''),
        inputSchema: (obj.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      };
    });
    return this.tools;
  }

  /** 调工具：文本拼成给模型看的文本，图片原样交出去（模型有视觉能力时能"看见"） */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 300_000,
  ): Promise<{ ok: boolean; text: string; images: Array<{ mime: string; data: string }> }> {
    await this.ensure();
    const res = (await this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs)) as {
      content?: unknown[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    const parts: string[] = [];
    const images: Array<{ mime: string; data: string }> = [];
    for (const block of res?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image' && typeof b.data === 'string') {
        const sizeKb = Math.round(b.data.length / 1024);
        images.push({ mime: String(b.mimeType ?? 'image/png'), data: b.data });
        parts.push(`[已附上截图：${b.mimeType ?? 'image/png'}，约 ${sizeKb}KB —— 直接看图判断界面内容]`);
      } else if (b.type === 'resource') parts.push(`[资源：${JSON.stringify(b.resource ?? {}).slice(0, 500)}]`);
      else parts.push(JSON.stringify(b).slice(0, 1000));
    }
    if (res?.structuredContent) parts.push(JSON.stringify(res.structuredContent));
    return { ok: !res?.isError, text: parts.join('\n').trim() || '（无输出）', images };
  }

  stop(): void {
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.failAll(new Error('MCP 连接已关闭'));
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
    }
  }
}
