/**
 * src/modules/plugins/builtin/fs.ts —— 文件与目录插件（增删改查）。
 *
 * 与旧项目的区别：**不做访问白名单**（需求 2：权限最大化），OS 权限就是唯一边界；
 * 但仍保留两条工程纪律：
 *  1. 写入前快照原内容（交给 undo 层，见 agent/journal.ts），让"撤销"可用；
 *  2. 大文件按行截断读取（读 1 万行文件不该把上下文撑爆），并如实告诉模型截断了。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PluginDef, Tool, ToolRunCtx } from '../types.ts';

/**
 * 约定：ToolResult.files 只放**可交付的产物**（在待下载目录里、能点开下载的东西）。
 * 文件工具"碰过哪些路径"不算交付物 —— 早先它们也往 files 里塞，
 * 界面就把它渲染成"可下载的文件卡"，读一个文件、列一个目录都会冒出一张下载卡（用户报的 bug）。
 * 改动的文件用 `lines`（+N/−M 行）表达，路径在追踪条那一行的参数里能看到。
 */
const DEFAULT_READ_LIMIT = 4000; // 行
const MAX_SEARCH_HITS = 200;

function resolve(ctx: ToolRunCtx, p: unknown): string {
  const raw = String(p ?? '').trim();
  if (!raw) throw new Error('缺少路径参数');
  const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '/', raw.slice(1)) : raw;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(ctx.cwd, expanded);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function readFile(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const file = resolve(ctx, args.path);
  const start = Math.max(1, Number(args.start_line ?? 1) || 1);
  const limit = Math.max(1, Number(args.lines ?? DEFAULT_READ_LIMIT) || DEFAULT_READ_LIMIT);
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new Error(`${file} 是目录，读目录内容请用 list_directory 或 directory_tree`);
  if (stat.size > 8 * 1024 * 1024 && !args.force) {
    return {
      ok: false,
      text: `${file} 有 ${fmtBytes(stat.size)}，超过 8MB。若确实要整读，请显式传 force=true；否则用 start_line/lines 分段读，或用 run_command 处理。`,
    };
  }
  const body = fs.readFileSync(file, 'utf8');
  const all = body.split(/\r?\n/);
  const picked = all.slice(start - 1, start - 1 + limit);
  const head = `文件：${file}（共 ${all.length} 行，本次显示第 ${start}–${start + picked.length - 1} 行）`;
  const numbered = picked.map((l, i) => `${start + i}\t${l}`).join('\n');
  return {
    ok: true,
    text: `${head}\n${numbered}`,
    note: `读 ${picked.length} 行`,
  };
}

async function writeFile(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const file = resolve(ctx, args.path);
  const content = String(args.content ?? '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.writeFileSync(file, content, 'utf8');
  ctx.log.info('write_file', { file, bytes: Buffer.byteLength(content) });
  const lines = diffLines(before ?? '', content);
  return {
    ok: true,
    text: `${before === null ? '已创建' : '已覆盖'}：${file}（${fmtBytes(Buffer.byteLength(content))}${lines ? `，+${lines.added}−${lines.removed} 行` : ''}）`,
    note: before === null ? '新建文件' : `覆盖 +${lines?.added ?? 0}−${lines?.removed ?? 0}`,
    lines,
  };
}

async function editFile(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const file = resolve(ctx, args.path);
  if (!fs.existsSync(file)) return { ok: false, text: `文件不存在：${file}（新建请用 write_file）` };
  const before = fs.readFileSync(file, 'utf8');
  const find = String(args.old_string ?? '');
  const replace = String(args.new_string ?? '');
  if (!find) return { ok: false, text: 'old_string 不能为空' };
  const count = before.split(find).length - 1;
  if (count === 0) return { ok: false, text: `没找到要替换的内容。old_string 必须与文件内容逐字一致（含缩进）。提示：先用 read_file 看原文。` };
  if (count > 1 && !args.replace_all) {
    return { ok: false, text: `old_string 在文件里出现 ${count} 次，不唯一。请带上更多上下文让它唯一，或传 replace_all=true 全部替换。` };
  }
  const after = args.replace_all ? before.split(find).join(replace) : before.replace(find, replace);
  fs.writeFileSync(file, after, 'utf8');
  ctx.log.info('edit_file', { file, count });
  const lines = diffLines(before, after);
  return {
    ok: true,
    text: `已修改：${file}（替换 ${args.replace_all ? count : 1} 处，+${lines?.added ?? 0}−${lines?.removed ?? 0} 行）`,
    note: `改 ${args.replace_all ? count : 1} 处`,
    lines,
  };
}

async function listDirectory(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const dir = resolve(ctx, args.path ?? '.');
  const items = fs.readdirSync(dir, { withFileTypes: true });
  const rows = items
    .filter((it) => args.show_hidden || !it.name.startsWith('.'))
    .map((it) => {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) return `d  ${it.name}/`;
      const st = fs.statSync(full);
      return `f  ${it.name}  (${fmtBytes(st.size)})`;
    });
  return {
    ok: true,
    text: `${dir}\n${rows.join('\n') || '（空目录）'}`,
    note: `${items.length} 项`,
  };
}

async function directoryTree(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const dir = resolve(ctx, args.path ?? '.');
  const maxDepth = Math.max(1, Number(args.depth ?? 2) || 2);
  const cap = Math.max(10, Number(args.max_entries ?? 300) || 300);
  const lines: string[] = [];
  const walk = (cur: string, depth: number, prefix: string) => {
    if (lines.length >= cap) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const it of items) {
      if (lines.length >= cap) return;
      if (it.name.startsWith('.') || it.name === 'node_modules') continue;
      lines.push(`${prefix}${it.isDirectory() ? '📁' : '📄'} ${it.name}`);
      if (it.isDirectory() && depth < maxDepth) walk(path.join(cur, it.name), depth + 1, `${prefix}  `);
    }
  };
  walk(dir, 0, '');
  const truncated = lines.length >= cap ? `\n（已截到 ${cap} 条；需要更多就指定更深的 depth 或换个子目录）` : '';
  return { ok: true, text: `${dir}\n${lines.join('\n')}${truncated}`, note: `${lines.length} 项` };
}

async function searchFiles(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const root = resolve(ctx, args.path ?? '.');
  const pattern = String(args.pattern ?? '').trim();
  if (!pattern) return { ok: false, text: 'pattern 不能为空' };
  const glob = typeof args.glob === 'string' ? args.glob : null;
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (hits.length >= MAX_SEARCH_HITS || depth > 12) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (hits.length >= MAX_SEARCH_HITS) return;
      if (it.name.startsWith('.') || it.name === 'node_modules') continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (glob && !simpleGlobMatch(it.name, glob)) continue;
      let text: string;
      try {
        const st = fs.statSync(full);
        if (st.size > 2 * 1024 * 1024) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(pattern)) {
          hits.push(`${full}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (hits.length >= MAX_SEARCH_HITS) break;
        }
      }
    }
  };
  walk(root, 0);
  return {
    ok: true,
    text: hits.length ? hits.join('\n') : `没有找到包含 "${pattern}" 的文件（在 ${root} 下）`,
    note: `${hits.length} 处命中`,
  };
}

function simpleGlobMatch(name: string, glob: string): boolean {
  const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

async function fileInfo(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const target = resolve(ctx, args.path);
  const st = fs.statSync(target);
  const kind = st.isDirectory() ? '目录' : st.isSymbolicLink() ? '符号链接' : '文件';
  return {
    ok: true,
    text: [
      `路径：${target}`,
      `类型：${kind}`,
      `大小：${fmtBytes(st.size)}`,
      `修改：${st.mtime.toISOString()}`,
      `权限：${(st.mode & 0o777).toString(8)}`,
    ].join('\n'),
    note: kind,
  };
}

async function createDirectory(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const dir = resolve(ctx, args.path);
  fs.mkdirSync(dir, { recursive: true });
  return { ok: true, text: `已创建目录：${dir}`, note: '建目录' };
}

async function moveFile(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const from = resolve(ctx, args.from);
  const to = resolve(ctx, args.to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return { ok: true, text: `已移动：${from} → ${to}`, note: '移动' };
}

async function deletePath(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const target = resolve(ctx, args.path);
  const st = fs.lstatSync(target);
  if (st.isDirectory()) {
    if (!args.recursive) {
      const n = fs.readdirSync(target).length;
      if (n > 0) return { ok: false, text: `${target} 是非空目录（${n} 项）。确认要删就传 recursive=true。` };
      fs.rmdirSync(target);
      return { ok: true, text: `已删除空目录：${target}`, note: '删目录' };
    }
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.rmSync(target);
  }
  return { ok: true, text: `已删除：${target}`, note: '删除' };
}

/** 行数差异（新增/删除行数，移动的行不计）——与 git diff --stat 同口径的近似 */
export function diffLines(before: string, after: string): { added: number; removed: number } | undefined {
  if (before === after) return undefined;
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (a.length > 20000 || b.length > 20000) return undefined;
  // 简单 LCS 长度 → 增删行数
  const m = a.length;
  const n = b.length;
  const dp = new Uint16Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i * (n + 1) + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * (n + 1) + (j - 1)]! + 1
          : Math.max(dp[(i - 1) * (n + 1) + j]!, dp[i * (n + 1) + (j - 1)]!);
    }
  }
  const lcs = dp[m * (n + 1) + n]!;
  return { added: n - lcs, removed: m - lcs };
}

const S = (desc: string, props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
  description: desc,
});

export function fsTools(): Tool[] {
  const t = (
    name: string,
    schema: Record<string, unknown>,
    run: (a: Record<string, unknown>, c: ToolRunCtx) => Promise<{ ok: boolean; text: string; note?: string; lines?: { added: number; removed: number }; files?: string[] }>,
  ): Tool => ({
    name,
    pluginId: 'fs',
    // 架构：schema 的首个 description 同时作为工具描述注册进提示词中心（界面可改）
    description: String((schema as { description?: string }).description ?? ''),
    schema,
    run: async (args, ctx) => run(args, ctx),
  });

  return [
    t('read_file', S('读文本文件。大文件用 start_line/lines 分段读。', {
      path: { type: 'string', description: '文件路径（绝对或相对工作目录）' },
      start_line: { type: 'number', description: '从第几行开始（1 起）' },
      lines: { type: 'number', description: `最多读多少行（默认 ${DEFAULT_READ_LIMIT}）` },
      force: { type: 'boolean', description: '超过 8MB 也整读（谨慎）' },
    }, ['path']), readFile),
    t('write_file', S('写文件（整份覆盖；新文件即创建）。改文件优先用 edit_file。', {
      path: { type: 'string' },
      content: { type: 'string', description: '完整文件内容' },
    }, ['path', 'content']), writeFile),
    t('edit_file', S('把文件里的 old_string 替换成 new_string。old_string 必须逐字一致且唯一（或传 replace_all）。', {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean', description: '替换全部出现处' },
    }, ['path', 'old_string', 'new_string']), editFile),
    t('list_directory', S('列目录内容（名字 + 大小）', {
      path: { type: 'string' },
      show_hidden: { type: 'boolean' },
    }), listDirectory),
    t('directory_tree', S('看目录树（默认 2 层，忽略隐藏项与 node_modules）', {
      path: { type: 'string' },
      depth: { type: 'number' },
      max_entries: { type: 'number' },
    }), directoryTree),
    t('search_files', S('在目录下按子串搜文件内容，返回 文件:行号: 内容', {
      path: { type: 'string', description: '搜索起点目录' },
      pattern: { type: 'string', description: '要搜的文本（区分大小写）' },
      glob: { type: 'string', description: '只搜匹配的文件名，如 *.js' },
    }, ['pattern']), searchFiles),
    t('get_file_info', S('文件/目录的详细信息（大小、时间、权限）', { path: { type: 'string' } }, ['path']), fileInfo),
    t('create_directory', S('创建目录（含父目录）', { path: { type: 'string' } }, ['path']), createDirectory),
    t('move_file', S('移动/重命名', { from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']), moveFile),
    t('delete_path', S('删除文件或目录；删非空目录要显式传 recursive=true', {
      path: { type: 'string' },
      recursive: { type: 'boolean' },
    }, ['path']), deletePath),
  ];
}

export const fsPlugin: Omit<PluginDef, 'tools'> & { tools: Tool[] } = {
  id: 'fs',
  name: '文件与目录',
  desc: '读写文件、列目录、搜索内容、增删改查',
  builtin: true,
  promptId: 'plugin.fs.usage',
  prompt: `文件与目录：read_file / write_file / edit_file / list_directory / directory_tree / search_files / get_file_info / create_directory / move_file / delete_path。
- 改文件优先用 edit_file（精确替换），整份重写才用 write_file。
- 路径可以是绝对路径，也可以是相对工作目录的相对路径；~ 会展开成家目录。`,
  params: [
    { key: 'read_lines', name: '单次读取行数上限', type: 'number', def: DEFAULT_READ_LIMIT, desc: 'read_file 默认读多少行' },
  ],
  tools: [],
};
