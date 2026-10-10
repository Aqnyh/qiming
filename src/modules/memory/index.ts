/**
 * src/modules/memory/index.ts —— 记忆模块。
 *
 * 记忆 = AI 工作的重要记录事项。一个记忆 = 一个 Markdown 文件（frontmatter + 正文），
 * 同目录的 MEMORY.md 是索引。作用域两种：
 *   global   本机通用事实（偏好、环境、账号、坑）
 *   project  某个项目的专属事实
 *
 * 为什么不放数据库：记忆要能被用户直接看、直接改、直接拷进别的工具（ZCode 等），
 * 文件 + frontmatter 是最通用的表示（旧项目已验证 ZCode 记忆 35/35 兼容）。
 *
 * 防呆：写索引时用"读现有条目重建"而不是拼接，避免出现索引与文件不一致。
 * 删除是软删除（进 .trash/），记忆被误删代价太高。
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, projectMemoryDir, projectDir } from '../../util/paths.ts';

export type Scope = { kind: 'global' } | { kind: 'project'; id: string; name?: string };

export type MemoryEntry = {
  /** 文件名（不含 .md） */
  slug: string;
  title: string;
  description: string;
  tags: string[];
  ts: number;
  updated: number;
  body: string;
  /** scope 标签，便于界面显示 */
  scopeLabel: string;
};

export function dirOf(scope: Scope): string {
  return scope.kind === 'global' ? MEMORY_DIR : projectMemoryDir(scope.id);
}

function labelOf(scope: Scope): string {
  return scope.kind === 'global' ? '全局' : `项目：${scope.name ?? scope.id}`;
}

function slugify(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || `mem-${Date.now().toString(36)}`;
}

/** 极简 frontmatter 解析（只认一层 key: value 与缩进子项，够用且无依赖） */
export function parseFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw };
  const head = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const meta: Record<string, string | string[]> = {};
  let lastKey = '';
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) {
      lastKey = m[1]!;
      const val = m[2]!.trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        meta[lastKey] = val
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else {
        meta[lastKey] = val.replace(/^["']|["']$/g, '');
      }
      continue;
    }
    // 缩进子项（metadata:\n  type: project）——折叠进父键，不做树
    const sub = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (sub && lastKey) {
      const cur = meta[lastKey];
      const pair = `${sub[1]}=${sub[2].trim()}`;
      meta[lastKey] = Array.isArray(cur) ? [...cur, pair] : cur ? [String(cur), pair] : pair;
    }
  }
  return { meta, body };
}

export function readEntryFile(file: string, scopeLabel: string): MemoryEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const stat = fs.statSync(file);
  const slug = path.basename(file, '.md');
  const title = String(meta.title ?? meta.name ?? slug);
  const description = String(meta.description ?? firstLine(body));
  const tagsRaw = meta.tags;
  const tags = Array.isArray(tagsRaw) ? tagsRaw : tagsRaw ? [String(tagsRaw)] : [];
  return {
    slug,
    title,
    description,
    tags,
    ts: stat.birthtimeMs || stat.mtimeMs,
    updated: stat.mtimeMs,
    body,
    scopeLabel,
  };
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim());
  return (line ?? '').replace(/^#+\s*/, '').slice(0, 80);
}

export function listEntries(scope: Scope): MemoryEntry[] {
  const dir = dirOf(scope);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    return [];
  }
  return files
    .map((f) => readEntryFile(path.join(dir, f), labelOf(scope)))
    .filter((e): e is MemoryEntry => Boolean(e))
    .sort((a, b) => b.updated - a.updated);
}

export function readEntry(scope: Scope, slug: string): MemoryEntry | null {
  const safe = path.basename(slug, '.md');
  return readEntryFile(path.join(dirOf(scope), `${safe}.md`), labelOf(scope));
}

export function search(scope: Scope, query: string, limit = 10): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  const all = listEntries(scope);
  if (!q) return all.slice(0, limit);
  const scored = all.map((e) => {
    const hay = `${e.title}\n${e.description}\n${e.tags.join(' ')}\n${e.body}`.toLowerCase();
    let score = 0;
    if (e.title.toLowerCase().includes(q)) score += 5;
    if (e.description.toLowerCase().includes(q)) score += 3;
    if (e.tags.some((t) => t.toLowerCase().includes(q))) score += 3;
    if (hay.includes(q)) score += 1;
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

export function writeEntry(
  scope: Scope,
  input: { slug?: string; title: string; description?: string; body: string; tags?: string[] },
): MemoryEntry {
  const dir = dirOf(scope);
  fs.mkdirSync(dir, { recursive: true });
  const slug = slugify(input.slug || input.title);
  const file = path.join(dir, `${slug}.md`);
  const existed = fs.existsSync(file);
  const fm = [
    '---',
    `name: ${slug}`,
    `title: ${input.title.replace(/\n/g, ' ')}`,
    `description: ${(input.description ?? firstLine(input.body)).replace(/\n/g, ' ')}`,
    `tags: [${(input.tags ?? []).join(', ')}]`,
    'metadata:',
    `  type: ${scope.kind === 'global' ? 'global' : 'project'}`,
    '---',
    '',
    input.body.trim(),
    '',
  ].join('\n');
  fs.writeFileSync(file, fm, 'utf8');
  rebuildIndex(scope);
  return { ...readEntryFile(file, labelOf(scope))!, slug, title: input.title, body: input.body, ...(existed ? {} : {}) };
}

export function removeEntry(scope: Scope, slug: string): boolean {
  const dir = dirOf(scope);
  const file = path.join(dir, `${path.basename(slug, '.md')}.md`);
  if (!fs.existsSync(file)) return false;
  const trash = path.join(dir, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(file, path.join(trash, `${path.basename(file, '.md')}-${Date.now()}.md`));
  rebuildIndex(scope);
  return true;
}

/** 索引由条目重建 —— 不拼接、不增量，永远与文件一致 */
export function rebuildIndex(scope: Scope): void {
  const dir = dirOf(scope);
  const entries = listEntries(scope);
  const lines = entries.map((e) => `- [${e.title}](memory/${e.slug}.md) — ${e.description}`);
  const head = scope.kind === 'global' ? '# 全局记忆\n\n' : `# 项目记忆\n\n`;
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), head + (lines.join('\n') || '（空）') + '\n', 'utf8');
}

/** 注入系统提示词用的索引块（只含标题+摘要，全文按需读） */
export function indexLines(scope: Scope, limit = 200): string[] {
  return listEntries(scope)
    .slice(0, limit)
    .map((e) => `- ${e.title}（${e.slug}）${e.description ? ` — ${e.description}` : ''}`);
}

export function ensureScopeDir(scope: Scope): void {
  fs.mkdirSync(dirOf(scope), { recursive: true });
}
export { projectDir };
