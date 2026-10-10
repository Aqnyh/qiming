/**
 * src/server/http.ts —— HTTP 层的公共件：响应、请求体、SSE、静态文件。
 *
 * 一条铁律来自旧项目的真实事故：**请求体先收 Buffer、再整体 UTF-8 解码**。
 * 逐 chunk `toString('utf8')` 会让跨 chunk 的中文变成 U+FFFD（写坏过 61 处正文）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PUBLIC_DIR } from '../util/paths.ts';

const MAX_BODY = 64 * 1024 * 1024;

export function json(res: ServerResponse, code: number, obj: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function text(res: ServerResponse, code: number, body: string, type = 'text/plain; charset=utf-8'): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

/* ────────────────────────── SSE ────────────────────────── */

export type SseWriter = {
  send: (obj: unknown) => void;
  close: () => void;
  /** 连接还活着吗（写失败即断开） */
  alive: boolean;
};

export function sseStart(req: IncomingMessage, res: ServerResponse): SseWriter {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': ok\n\n');
  const state = { alive: true };
  const heartbeat = setInterval(() => {
    if (!state.alive) return;
    try {
      res.write(': ping\n\n');
    } catch {
      state.alive = false;
    }
  }, 25_000);
  heartbeat.unref?.();
  const close = () => {
    if (!state.alive) return;
    state.alive = false;
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* 已经断开 */
    }
  };
  req.on('close', () => {
    state.alive = false;
    clearInterval(heartbeat);
  });
  const send = (obj: unknown) => {
    if (!state.alive) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      state.alive = false;
      clearInterval(heartbeat);
    }
  };
  return { send, close, get alive() { return state.alive; } };
}

/* ────────────────────────── 静态文件 ────────────────────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 静态资源：public/ 下；找不到就回落 index.html（单页应用） */
export function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) return false;
  let file = target;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(index)) return false;
    file = index;
  }
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'content-type': mimeOf(file),
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

/** 文件服务：支持 Range（视频/音频拖进度条）与 inline 预览 */
export function serveFile(req: IncomingMessage, res: ServerResponse, file: string, opts?: { inline?: boolean }): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    text(res, 404, '文件不存在');
    return;
  }
  if (stat.isDirectory()) {
    text(res, 400, '这是一个目录');
    return;
  }
  const type = mimeOf(file);
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  };
  if (opts?.inline) headers['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  else headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  fs.createReadStream(file).pipe(res);
}

export function notFound(res: ServerResponse): void {
  text(res, 404, 'not found');
}
