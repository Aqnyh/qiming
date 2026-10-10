/**
 * src/util/paths.ts —— data/ 目录布局的唯一真源。
 *
 * 为什么单独一份：路径拼接散开就会出现"两处各写一份、改一处漏一处"的老问题。
 * 其它模块只能从这里拿路径，不许自己 path.join(DATA_ROOT, ...)。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/** 工程根（server.ts 在根目录，本文件在 src/util/ 下） */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DATA_ROOT = process.env.QIMING_DATA ?? path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
export const SESSIONS_FILE = path.join(DATA_ROOT, 'sessions.json');
export const PROJECTS_FILE = path.join(DATA_ROOT, 'projects.json');
export const PROMPTS_FILE = path.join(DATA_ROOT, 'prompts.json');
export const PLUGINS_FILE = path.join(DATA_ROOT, 'plugins.json');
export const SKILLS_FILE = path.join(DATA_ROOT, 'skills.json');
export const RESOURCES_FILE = path.join(DATA_ROOT, 'resources.json');

export const MEMORY_DIR = path.join(DATA_ROOT, 'memory');
export const SKILLS_DIR = path.join(DATA_ROOT, 'skills');
export const PROJECTS_DIR = path.join(DATA_ROOT, 'projects');
export const RUNS_DIR = path.join(DATA_ROOT, 'runs');
export const ARCHIVE_DIR = path.join(DATA_ROOT, 'archives');
export const DOWNLOADS_DIR = path.join(DATA_ROOT, 'downloads');
/** 检查点影子仓库根目录：每个会话一个（内含 git 目录与快照树） */
export const CHECKPOINTS_DIR = path.join(DATA_ROOT, 'checkpoints');

export function checkpointDir(sessionId: string): string {
  return path.join(CHECKPOINTS_DIR, path.basename(sessionId));
}

export function projectDir(id: string): string {
  return path.join(PROJECTS_DIR, id);
}
export function projectMemoryDir(id: string): string {
  return path.join(projectDir(id), 'memory');
}
export function runDir(runId: string): string {
  return path.join(RUNS_DIR, runId);
}
export function skillDir(name: string): string {
  return path.join(SKILLS_DIR, name);
}

export function ensureDirs(): void {
  for (const dir of [
    DATA_ROOT, MEMORY_DIR, SKILLS_DIR, PROJECTS_DIR, RUNS_DIR, ARCHIVE_DIR, DOWNLOADS_DIR, CHECKPOINTS_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 本机账号：登录即它的登录，命令也以它执行 */
export function osUser(): string {
  return process.env.SUDO_USER || process.env.USER || os.userInfo().username;
}
export function osHome(): string {
  return os.homedir();
}
