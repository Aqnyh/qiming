/**
 * src/util/log.ts —— 极简结构化日志。
 *
 * 为什么走 stderr：站点/服务常用 stdout 做机器可读输出，日志混进去会破坏解析
 * （旧项目踩过这个坑）。级别用 env 控制：QIMING_LOG=debug|info|warn|error。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const current: number = LEVELS[(process.env.QIMING_LOG as Level) ?? 'info'] ?? LEVELS.info;

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < current) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const tail = extra === undefined ? '' : ` ${safe(extra)}`;
  process.stderr.write(`[${stamp}] ${level.toUpperCase().padEnd(5)} ${scope} ${msg}${tail}\n`);
}

function safe(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export type Logger = {
  debug: (msg: string, extra?: unknown) => void;
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
};

export function logger(scope: string): Logger {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}
