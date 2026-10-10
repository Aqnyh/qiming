/**
 * scripts/build-ui.mjs —— 前端构建：ui/ → public/app.js + public/app.css。
 *
 *   node scripts/build-ui.mjs              # 生产构建（minify）
 *   node scripts/build-ui.mjs --watch      # 监听源码变化（JS 走 esbuild watch，CSS 走 tailwind --watch）
 *   node scripts/build-ui.mjs --no-minify  # 不压缩（排查线上问题用）
 *   node scripts/build-ui.mjs --sourcemap  # 产出 app.js.map（默认 watch 时 inline，生产不带）
 *
 * 两块产物的分工：
 *   app.js  —— esbuild 打包（含 React；format=iife，环境里直接 <script src> 就能跑，不需要 ESM 服务端配合）
 *   app.css —— Tailwind v4 CLI 编译（@import "tailwindcss" 只能由它解析，不能交给 esbuild）
 *
 * 为什么显式 define process.env.NODE_ENV：esbuild 只在 minify 时自动定义它，
 * watch 模式（不 minify）下 React 会去找浏览器里不存在的 process 全局而崩。
 */
import { build, context } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sourceStamp } from './source-stamp.mjs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const stamp = sourceStamp(ROOT);
const OUT_DIR = path.join(ROOT, 'public');
const UI = path.join(ROOT, 'ui');

const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const sourcemap = argv.includes('--sourcemap') ? true : watch ? 'inline' : false;
const minify = argv.includes('--no-minify') ? false : !watch;

fs.mkdirSync(OUT_DIR, { recursive: true });

/** Tailwind v4 CLI：解析 @import "tailwindcss"（esbuild 不认这个指令） */
function tailwindBin() {
  const cli = path.join(ROOT, 'node_modules/@tailwindcss/cli/dist/index.mjs');
  if (!fs.existsSync(cli)) {
    throw new Error('缺少 @tailwindcss/cli —— 先在工程根目录执行 npm install');
  }
  return cli;
}

function buildCss() {
  const args = [tailwindBin(), '-i', path.join(UI, 'styles.css'), '-o', path.join(OUT_DIR, 'app.css')];
  if (minify) args.push('--minify');
  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
}

const options = {
  entryPoints: [path.join(UI, 'main.jsx')],
  outfile: path.join(OUT_DIR, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'firefox110', 'safari16'],
  jsx: 'automatic',
  minify,
  sourcemap,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
    // 构建时的后端源码指纹：界面拿它跟 GET /api/version 比，就能发现"新前端打旧后端"
    __QIMING_STAMP__: JSON.stringify(stamp),
  },
  logLevel: 'info',
  ...(minify ? { drop: ['debugger'] } : {}),
};

if (watch) {
  buildCss();
  // CSS 的 --watch 是常驻进程（Tailwind CLI 自带），JS 用 esbuild 的 watch context
  const css = spawn(process.execPath, [tailwindBin(), '-i', path.join(UI, 'styles.css'), '-o', path.join(OUT_DIR, 'app.css'), '--watch'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  const ctx = await context(options);
  await ctx.watch();
  console.log('\n  👀 ui/ 监听中（改 styles.css 由 Tailwind 自己重编）\n');
  const stop = () => {
    css.kill();
    void ctx.dispose().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  buildCss();
  const r = await build({ ...options, metafile: true });
  const bytes = Object.values(r.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
  const cssSize = fs.statSync(path.join(OUT_DIR, 'app.css')).size;
  console.log(`\n  ✅ 构建完成`);
  console.log(`     public/app.js   ${(bytes / 1024).toFixed(0)} KB${sourcemap ? '（含 sourcemap）' : ''}`);
  console.log(`     public/app.css  ${(cssSize / 1024).toFixed(0)} KB`);
}
