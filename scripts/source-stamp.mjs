/**
 * scripts/source-stamp.mjs —— 后端源码的指纹（内容哈希）。
 *
 * 为什么需要它：本工程"前端重新构建"和"后端进程重启"是两件独立的事 ——
 * 只 build 不重启，就会出现**新前端打旧后端**：界面上新加的按钮点下去报「没有这个接口」。
 * 这个坑旧项目踩过（"改了 lib/agent/* 必须 down.sh+up.sh 重启"），所以这里做成自检：
 *   · 构建前端时把当时的源码指纹写进 bundle（__QIMING_STAMP__）；
 *   · 服务进程启动时算一次自己的指纹，用 GET /api/version 暴露；
 *   · 界面一比对，不一致就顶上挂一条提示，告诉你该重启了。
 *
 * 用**内容哈希**而不是 mtime：复制/检出文件会改 mtime 但内容没变，
 * 那会造成"每次都提示重启"的狼来了。
 */
import fs from 'node:fs';
import path from 'node:path';

function walk(dir, out) {
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    if (it.name.startsWith('.') || it.name === 'node_modules') continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, out);
    else if (/\.(ts|mjs)$/.test(it.name)) out.push(full);
  }
  return out;
}

/** 后端源码（server.ts + src/ 下的 .ts/.mjs）的内容指纹：改了内容才会变 */
export function sourceStamp(root) {
  const files = walk(path.join(root, 'src'), []);
  const entry = path.join(root, 'server.ts');
  if (fs.existsSync(entry)) files.push(entry);
  files.sort();

  let h = 5381;
  for (const file of files) {
    const rel = path.relative(root, file);
    const body = fs.readFileSync(file, 'utf8');
    const chunk = `${rel}\u0000${body}\u0000`;
    for (let i = 0; i < chunk.length; i++) h = ((h * 33) ^ chunk.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
