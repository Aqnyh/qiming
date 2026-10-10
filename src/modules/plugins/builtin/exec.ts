/**
 * src/modules/plugins/builtin/exec.ts —— 命令行插件。
 *
 * 需求 2 的落点：以本机账号身份执行，**没有访问级别、没有危险命令清单**；
 * 登录后（拿到本机密码）还可以直接跑 sudo —— 实现方式是把密码交给 `SUDO_ASKPASS`
 * 助手脚本，这样命令里**任何位置**的 sudo（包括脚本内部的）都能非交互拿到权限，
 * 而不是只在命令开头拼一个 sudo。
 *
 * 三条工程纪律照旧保留（与权限无关，是可靠性）：
 *  1. 独立进程组执行 + 超时 `SIGKILL` 整组（否则后台子进程会活下来占端口/占文件）；
 *  2. 输出按字节收完再整体 UTF-8 解码（逐 chunk 解码会把跨 chunk 的中文变成 U+FFFD）；
 *  3. 超时/被杀时如实报告，不把"没跑完"说成"跑完了"。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginDef, Tool, ToolRunCtx } from '../types.ts';
import { DATA_ROOT } from '../../../util/paths.ts';

const DEFAULT_TIMEOUT = 600;
const DEFAULT_MAX_OUTPUT_KB = 512;
const HARD_STREAM_CAP = 64 * 1024 * 1024; // 单纯防 OOM 的兜底，远高于默认值

type ExecResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  truncated: boolean;
};

function askpassScript(ctx: ToolRunCtx): string | null {
  const pw = ctx.sudoPassword();
  if (!pw) return null;
  const dir = path.join(DATA_ROOT, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `askpass-${process.pid}.sh`);
  // 单引号包裹 + 内部单引号转义，避免密码里的引号破坏脚本
  const quoted = `'${pw.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${quoted}\n`, { mode: 0o700 });
  return file;
}

function runOnce(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec: number;
  maxOutputKb: number;
  asRoot: boolean;
  signal: AbortSignal;
}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = input.asRoot ? ['-A', '-p', '', 'bash', '-lc', input.command] : ['-lc', input.command];
    const bin = input.asRoot ? 'sudo' : 'bash';
    const child = spawn(bin, args, {
      cwd: input.cwd,
      env: input.env,
      detached: true, // 独立进程组：超时能整组杀
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outs: Buffer[] = [];
    const errs: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    const capBytes = Math.min(HARD_STREAM_CAP, Math.max(4, input.maxOutputKb) * 1024);

    const collect = (target: Buffer[], chunk: Buffer, which: 'out' | 'err') => {
      const used = which === 'out' ? outBytes : errBytes;
      if (used >= capBytes) {
        truncated = true;
        return;
      }
      const room = capBytes - used;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (chunk.length > room) truncated = true;
      target.push(slice);
      if (which === 'out') outBytes += slice.length;
      else errBytes += slice.length;
    };
    child.stdout?.on('data', (c: Buffer) => collect(outs, c, 'out'));
    child.stderr?.on('data', (c: Buffer) => collect(errs, c, 'err'));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, Math.max(1, input.timeoutSec) * 1000);

    const onAbort = () => killGroup(child.pid);
    input.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: `无法执行：${err.message}`,
        ms: Date.now() - started,
        timedOut,
        truncated,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(outs).toString('utf8'),
        stderr: Buffer.concat(errs).toString('utf8'),
        ms: Date.now() - started,
        timedOut,
        truncated,
      });
    });
  });
}

function killGroup(pid?: number): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出了 */
    }
  }
}

async function runCommand(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const command = String(args.command ?? '').trim();
  if (!command) return { ok: false, text: 'command 不能为空' };
  const budgetKey = 'exec';
  if (ctx.remaining(budgetKey) <= 0) {
    return {
      ok: false,
      text: ctx.prompt('loop.budget_exhausted', { plugin: 'exec', detail: `本次运行最多 ${ctx.param('max_calls')} 条命令` }),
    };
  }
  ctx.spend(budgetKey);

  const timeoutSec = Number(args.timeout_sec ?? ctx.param('timeout_sec') ?? DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT;
  const maxOutputKb = Number(ctx.param('max_output_kb') ?? DEFAULT_MAX_OUTPUT_KB) || DEFAULT_MAX_OUTPUT_KB;
  const asRoot = args.sudo === true;
  const cwd = args.cwd ? path.resolve(ctx.cwd, String(args.cwd)) : ctx.cwd;

  const env: NodeJS.ProcessEnv = { ...process.env, QIMING_RUN_ID: ctx.runId };
  const askpass = askpassScript(ctx);
  if (askpass) env.SUDO_ASKPASS = askpass;
  if (asRoot && !askpass) {
    return { ok: false, text: '要以 root 执行需要先用本机账号登录（登录后密码会用于 sudo）。' };
  }

  const res = await runOnce({ command, cwd, env, timeoutSec, maxOutputKb, asRoot, signal: ctx.signal });
  const parts: string[] = [];
  const head = `$ ${asRoot ? 'sudo ' : ''}${command}\n（工作目录：${cwd}）`;
  parts.push(head);
  if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''));
  if (res.stderr) parts.push(`--- stderr ---\n${res.stderr.replace(/\s+$/, '')}`);
  parts.push(
    `--- 退出码 ${res.code ?? 'null'}${res.signal ? `（信号 ${res.signal}）` : ''}，用时 ${(res.ms / 1000).toFixed(2)}s${res.timedOut ? `，超时 ${timeoutSec}s 被强杀` : ''}${res.truncated ? '，输出已截断' : ''}`,
  );
  if (res.timedOut) {
    parts.push('提示：超时被杀。长任务用 `setsid nohup <命令> > 日志 2>&1 < /dev/null &` 提交后台，再用 read_file 看日志。');
  }
  const ok = res.code === 0 && !res.timedOut;
  return {
    ok,
    text: parts.join('\n\n'),
    note: `${ok ? 'ok' : `退出码 ${res.code ?? '被杀'}`} · ${(res.ms / 1000).toFixed(1)}s`,
  };
}

const schema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: '要执行的命令（bash -lc）' },
    cwd: { type: 'string', description: '工作目录（默认项目根）' },
    timeout_sec: { type: 'number', description: `超时秒数（默认取插件参数 ${DEFAULT_TIMEOUT}）；到点杀整个进程组` },
    sudo: { type: 'boolean', description: '以 root 执行（登录后可用）' },
  },
  required: ['command'],
  additionalProperties: false,
};

export const execTools = (): Tool[] => [
  {
    name: 'run_command',
    pluginId: 'exec',
    description: '执行 bash 命令（可 sudo）；超时杀整个进程组，长任务请放后台',
    schema,
    run: runCommand,
  },
];

export const execPlugin: Omit<PluginDef, 'tools'> & { tools: Tool[] } = {
  id: 'exec',
  name: '命令行',
  desc: '执行系统命令（可 sudo），超时杀进程组',
  builtin: true,
  promptId: 'plugin.exec.usage',
  prompt: `命令行：run_command(command, cwd?, timeout_sec?, sudo?)。
- **超时的含义是"杀掉整个进程组再返回"，不是"放弃等待"** —— 长任务必须自己放后台：
  \`setsid nohup <命令> > /tmp/日志 2>&1 < /dev/null &\`，然后稍后用 read_file 或 tail 看日志。
- 需要 root 时传 sudo=true（或用命令内部的 sudo，登录后都能拿到权限）。
- 一次运行的命令条数有额度，别用它做"批量文件操作"（那用文件插件或一条命令搞定）。`,
  params: [
    { key: 'timeout_sec', name: '单条命令超时（秒）', type: 'number', def: DEFAULT_TIMEOUT },
    { key: 'max_calls', name: '每次运行最多几条命令', type: 'number', def: 60 },
    { key: 'max_output_kb', name: '单条命令输出上限（KB）', type: 'number', def: DEFAULT_MAX_OUTPUT_KB },
  ],
  tools: [],
};
