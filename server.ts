/**
 * server.ts —— 启明（Qiming）服务入口。
 *
 *   node server.ts            # 默认 0.0.0.0:8787
 *   PORT=9000 node server.ts
 *   QIMING_AUTH=off node server.ts   # 关掉登录（自动化测试用）
 *
 * 后端零构建：Node 22 原生类型剥离直接跑 .ts（所以 import 路径必须带 .ts 后缀、
 * 类型导入必须用 `import type`）。类型检查用 `npm run typecheck`。
 */
import http from 'node:http';
import { createApp } from './src/server/app.ts';
import { handleApi } from './src/server/api.ts';
import { serveStatic, json, serveFile } from './src/server/http.ts';
import { logger } from './src/util/log.ts';
import { osHome, osUser, DATA_ROOT } from './src/util/paths.ts';
import path from 'node:path';
import { sourceStamp } from './scripts/source-stamp.mjs';

const log = logger('server');
const ROOT = path.resolve(import.meta.dirname);
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = createApp();
// 本进程启动时对应的源码指纹：界面拿它跟构建时的指纹比 → 不一致就提示"该重启了"
const SOURCE_STAMP = sourceStamp(ROOT);
const STARTED_AT = Date.now();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  void (async () => {
    try {
      // 版本自检（免登录：只报指纹/启动时间/pid，不泄露任何配置）
      if (url.pathname === '/api/version') {
        return json(res, 200, { stamp: SOURCE_STAMP, startedAt: STARTED_AT, pid: process.pid, node: process.version });
      }

      if (await handleApi(req, res, url, app)) return;

      // 待下载文件（会话卡片与「待下载」菜单都用它）
      if (url.pathname === '/files/download') {
        const name = path.basename(url.searchParams.get('name') ?? '');
        if (!name) return json(res, 400, { error: 'name 必填' });
        return serveFile(req, res, path.join(DATA_ROOT, 'downloads', name), {
          inline: url.searchParams.get('inline') === '1',
        });
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });
        if (serveStatic(res, url.pathname)) return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error('请求处理失败', { url: url.pathname, err: String(err) });
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

server.listen(PORT, HOST, () => {
  log.info(`启明已启动`, { url: `http://${HOST}:${PORT}`, user: osUser(), home: osHome(), data: DATA_ROOT });
  // 这行是 up.sh 与测试脚本的启动判据，措辞别改（改了两边都要跟着改）
  process.stdout.write(`\n启明已启动：\n  http://127.0.0.1:${PORT}/\n`);
  if (HOST === '0.0.0.0') {
    process.stdout.write(`  局域网（手机/其它设备）：用本机 IP + ${PORT} 访问\n`);
    process.stdout.write(`  注意：本工程按需求不设访问控制，只在本机与可信内网使用。\n\n`);
  }
});

function shutdown(sig: string): void {
  log.info(`收到 ${sig}，正在退出…`);
  try {
    app.stopWatch();
    app.resources.stopAll();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('未处理的 Promise 拒绝', { err: String(err) }));
process.on('uncaughtException', (err) => log.error('未捕获异常', { err: String(err) }));
