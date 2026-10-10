/**
 * src/store/projects.ts —— 项目 = 一个根目录（+ 它自己的记忆文件夹）。
 *
 * 会话属于项目；项目记忆跨会话共享，存在 data/projects/<id>/memory/。
 * 记忆文件格式与旧项目/ZCode 兼容（frontmatter + MEMORY.md 索引），可直接拷贝。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, now } from './kv.ts';
import { PROJECTS_FILE, projectDir, projectMemoryDir, PROJECTS_DIR } from '../util/paths.ts';

export type Project = {
  id: string;
  root: string;
  name: string;
  created: number;
  updated: number;
  /** 置顶（排在项目列表最前） */
  pinned?: boolean;
  /** 归档时间（有值 = 在归档页；它的会话也一起归档） */
  archivedAt?: number;
};

type Store = { version: number; current: string | null; projects: Project[] };

const EMPTY: Store = { version: 1, current: null, projects: [] };

export function idForRoot(root: string): string {
  const base = path.basename(root).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 40) || 'project';
  let hash = 0;
  for (let i = 0; i < root.length; i++) hash = (hash * 31 + root.charCodeAt(i)) | 0;
  return `${base}-${(hash >>> 0).toString(36).slice(0, 6)}`;
}

export function readProjects(): Store {
  const s = readJson<Store>(PROJECTS_FILE, EMPTY);
  return { version: 1, current: s.current ?? null, projects: Array.isArray(s.projects) ? s.projects : [] };
}

export function listProjects(opts: { archived?: boolean; all?: boolean } = {}): Project[] {
  const all = readProjects().projects;
  const list = opts.all ? all : all.filter((p) => Boolean(p.archivedAt) === (opts.archived === true));
  return list.slice().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated - a.updated);
}

export function findProject(id: string | null | undefined): Project | null {
  if (!id) return null;
  return readProjects().projects.find((p) => p.id === id) ?? null;
}

export function currentProject(): Project | null {
  const s = readProjects();
  return s.projects.find((p) => p.id === s.current) ?? null;
}

export function addProject(root: string, name?: string): Project {
  const abs = path.resolve(root);
  const s = readProjects();
  const existing = s.projects.find((p) => p.root === abs);
  if (existing) return existing;
  const proj: Project = {
    id: idForRoot(abs),
    root: abs,
    name: name?.trim() || path.basename(abs),
    created: now(),
    updated: now(),
  };
  s.projects.push(proj);
  s.current = proj.id;
  writeJson(PROJECTS_FILE, s);
  fs.mkdirSync(projectMemoryDir(proj.id), { recursive: true });
  seedProjectMemory(proj);
  return proj;
}

export function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'root'>>): Project | null {
  const s = readProjects();
  const i = s.projects.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const cur = s.projects[i]!;
  s.projects[i] = { ...cur, ...patch, updated: now() };
  writeJson(PROJECTS_FILE, s);
  return s.projects[i]!;
}

export function removeProject(id: string, opts?: { keepFiles?: boolean }): boolean {
  const s = readProjects();
  const i = s.projects.findIndex((p) => p.id === id);
  if (i < 0) return false;
  s.projects.splice(i, 1);
  if (s.current === id) s.current = s.projects[0]?.id ?? null;
  writeJson(PROJECTS_FILE, s);
  if (!opts?.keepFiles) fs.rmSync(projectDir(id), { recursive: true, force: true });
  return true;
}

export function pinProject(id: string, pinned: boolean): Project | null {
  const s = readProjects();
  const p = s.projects.find((x) => x.id === id);
  if (!p) return null;
  p.pinned = pinned;
  writeJson(PROJECTS_FILE, s);
  return p;
}

/** 归档项目：项目与它的会话一起进归档页（磁盘上的项目目录一个字都不动） */
export function archiveProject(id: string, archived: boolean): Project | null {
  const s = readProjects();
  const p = s.projects.find((x) => x.id === id);
  if (!p) return null;
  if (archived) p.archivedAt = now();
  else delete p.archivedAt;
  writeJson(PROJECTS_FILE, s);
  return p;
}

/** 彻底删除项目：记录 + 项目记忆目录（磁盘上的项目文件不动，那是用户的代码） */
export function purgeProjectData(id: string): void {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}

export function setCurrentProject(id: string | null): void {
  const s = readProjects();
  s.current = id;
  writeJson(PROJECTS_FILE, s);
}

/** 新建项目时种一条记忆：这条很快会被证明有用（会话默认 cwd 就在这里） */
function seedProjectMemory(proj: Project): void {
  const dir = projectMemoryDir(proj.id);
  const slug = 'project-root';
  const file = path.join(dir, `${slug}.md`);
  if (fs.existsSync(file)) return;
  fs.writeFileSync(
    file,
    [
      '---',
      `name: ${slug}`,
      `description: 项目根目录`,
      'metadata:',
      '  type: project',
      '---',
      '',
      `这个项目的根目录是 \`${proj.root}\`，命令默认以它为工作目录。`,
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'MEMORY.md'),
    `- [项目根目录](memory/${slug}.md) — 项目根目录是 ${proj.root}\n`,
    'utf8',
  );
}

/**
 * 工作区约束（需求 3）：项目根目录必须在工作区之下。
 * 返回规范化后的绝对路径，越界则返回 null（调用方给人话）。
 * 为什么用 path.relative 而不是 startsWith：`/a/bc` 不该被判定为在 `/a/b` 之内。
 */
export function insideWorkspace(root: string, workspace: string): string | null {
  if (!workspace) return path.resolve(root);
  const abs = path.resolve(root);
  const rel = path.relative(path.resolve(workspace), abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return abs;
  return null;
}

/** 会话默认工作目录 = 项目根；没有项目就用家目录 */
export function cwdOf(project: Project | null, fallback: string): string {
  if (project && fs.existsSync(project.root)) return project.root;
  return fallback;
}

export { PROJECTS_DIR };
