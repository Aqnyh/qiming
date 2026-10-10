/**
 * src/modules/skills/index.ts —— 技能模块。
 *
 * 技能 = AI 工作的具体方法，采用 2025-12 起成为开放标准的 SKILL.md 格式
 * （Anthropic Agent Skills / agentskills.io 规范）：
 *
 *   ---
 *   name: pdf-split
 *   description: 什么时候用这个技能（模型靠它决定要不要载入）
 *   ---
 *   正文：步骤、命令、坑、验证方式
 *
 * 渐进式披露（progressive disclosure）：系统提示词里只常驻 name + description 目录，
 * 模型决定要用时调 use_skill 载入全文 —— 这样技能再多也不挤占上下文。
 *
 * 目录结构（与主流实现一致）：data/skills/<name>/SKILL.md + 可选 scripts/ references/ assets/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR, SKILLS_FILE, skillDir } from '../../util/paths.ts';
import { readJson, writeJson } from '../../store/kv.ts';
import { parseFrontmatter } from '../memory/index.ts';

export type SkillMeta = {
  name: string;
  description: string;
  enabled: boolean;
  dir: string;
  /** 附属文件（相对技能目录） */
  files: string[];
  updated: number;
};

type Store = { version: number; skills: Record<string, { enabled?: boolean }> };

const EMPTY: Store = { version: 1, skills: {} };

/**
 * 技能名：小写字母/数字/连字符（开放标准），**额外允许中文**。
 * 为什么放宽：这是本机私有技能库，中文名（"批量改名"）比 `batch-rename` 好读也好找；
 * 从社区导入的技能本来就叫 ASCII 名，两者不冲突。
 */
export function validName(name: string): boolean {
  return /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5-]{0,63}$/.test(name);
}

export function slugName(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || `skill-${Date.now().toString(36)}`;
}

function store(): Store {
  const s = readJson<Store>(SKILLS_FILE, EMPTY);
  return { version: 1, skills: s.skills && typeof s.skills === 'object' ? s.skills : {} };
}

function saveStore(s: Store): void {
  writeJson(SKILLS_FILE, s);
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let items: fs.Dirent[] = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    if (it.name === 'SKILL.md' || it.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${it.name}` : it.name;
    if (it.isDirectory()) out.push(`${rel}/`, ...listFiles(path.join(dir, it.name), rel));
    else out.push(rel);
  }
  return out;
}

export function list(): SkillMeta[] {
  const st = store();
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const name of dirs) {
    const dir = skillDir(name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const stat = fs.statSync(file);
    out.push({
      name: String(meta.name ?? name),
      description: String(meta.description ?? ''),
      enabled: st.skills[name]?.enabled !== false,
      dir,
      files: listFiles(dir),
      updated: stat.mtimeMs,
    });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export function read(name: string): { meta: SkillMeta; body: string } | null {
  const dir = skillDir(name);
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const item = list().find((s) => s.name === name || path.basename(s.dir) === name);
  return {
    meta:
      item ??
      {
        name,
        description: String(meta.description ?? ''),
        enabled: true,
        dir,
        files: listFiles(dir),
        updated: fs.statSync(file).mtimeMs,
      },
    body,
  };
}

export function write(input: { name: string; description: string; body: string; overwriteName?: string }): SkillMeta {
  const name = validName(input.name) ? input.name : slugName(input.name);
  const dir = skillDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = ['---', `name: ${name}`, `description: ${input.description.replace(/\n/g, ' ').trim()}`, '---', '', input.body.trim(), ''].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm, 'utf8');
  const all = list();
  return all.find((s) => s.name === name) ?? {
    name,
    description: input.description,
    enabled: true,
    dir,
    files: [],
    updated: Date.now(),
  };
}

export function remove(name: string): boolean {
  const dir = skillDir(name);
  if (!fs.existsSync(dir)) return false;
  const trash = path.join(SKILLS_DIR, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(dir, path.join(trash, `${name}-${Date.now()}`));
  const st = store();
  delete st.skills[name];
  saveStore(st);
  return true;
}

export function setEnabled(name: string, enabled: boolean): void {
  const st = store();
  st.skills[name] = { ...(st.skills[name] ?? {}), enabled };
  saveStore(st);
}

/** 从一份 Markdown 文本导入技能（没有 frontmatter 就用首行标题当 name） */
export function importMarkdown(text: string, fallbackName?: string): SkillMeta {
  const { meta, body } = parseFrontmatter(text);
  const rawName = String(meta.name ?? fallbackName ?? firstHeading(body) ?? '');
  const name = validName(slugName(rawName)) ? slugName(rawName) : slugName(rawName);
  const description = String(meta.description ?? firstParagraph(body) ?? '');
  return write({ name, description, body });
}

/** 从某目录导入：认 `<名>/SKILL.md`，也认目录下任意 `*.md`（跟一层软链） */
export function importDir(srcDir: string): SkillMeta[] {
  const out: SkillMeta[] = [];
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const it of entries) {
    const full = path.join(srcDir, it.name);
    const isDir = it.isDirectory() || (it.isSymbolicLink() && safeStat(full)?.isDirectory());
    if (isDir) {
      const skillMd = path.join(full, 'SKILL.md');
      if (fs.existsSync(skillMd)) out.push(importMarkdown(fs.readFileSync(skillMd, 'utf8'), it.name));
      continue;
    }
    if (it.name.toLowerCase().endsWith('.md')) {
      out.push(importMarkdown(fs.readFileSync(full, 'utf8'), path.basename(it.name, '.md')));
    }
  }
  return out;
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1]!.trim() : null;
}
function firstParagraph(body: string): string | null {
  const line = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
  return line ? line.trim().slice(0, 200) : null;
}

/** 注入系统提示词的目录行（技能多了也只占一行一个） */
export function indexLines(onlyEnabled = true): string[] {
  return list()
    .filter((s) => !onlyEnabled || s.enabled)
    .map((s) => `- ${s.name}：${s.description}`);
}

/** use_skill 的返回体：全文 + 附属文件清单 + 目录 */
export function load(name: string): { name: string; description: string; body: string; dir: string; files: string[] } | null {
  const found = read(name);
  if (!found) return null;
  return {
    name: found.meta.name,
    description: found.meta.description,
    body: found.body,
    dir: found.meta.dir,
    files: found.meta.files,
  };
}

export function ensureDir(): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

/**
 * 种下内置技能（只在缺失时写，不覆盖用户/agent 改过的版本）。
 * 目前一份：`agent-modules` —— 插件/资源/提示词/技能/记忆这五样东西的文件位置与字段表，
 * 让 agent 能按需求 3「直接改文件来给自己新增和修改」。
 */
export function seedBuiltin(): void {
  ensureDir();
  const src = path.join(import.meta.dirname, 'seed-agent-modules.md');
  const dest = path.join(skillDir('agent-modules'), 'SKILL.md');
  if (fs.existsSync(dest)) return;
  try {
    const text = fs.readFileSync(src, 'utf8');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, 'utf8');
  } catch {
    /* 种不上不影响启动：agent 还能直接读现有文件照抄结构 */
  }
}
