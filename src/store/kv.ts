/**
 * src/store/kv.ts —— JSON 文件读写的地基。
 *
 * 三个纪律（都是从旧项目的真实事故里总结的）：
 *  1. 原子写：先写 `.tmp` 再 rename，避免半截文件（进程被杀/磁盘满时留不下半份 JSON）。
 *  2. 覆盖前留档：写之前把旧文件复制成 `.bak`，配错了还能捞回来。
 *  3. 损坏不抛：读到坏 JSON 时把坏文件另存 `.corrupt-<时间戳>` 再回退默认值，
 *     否则一个坏文件会让整个服务起不来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../util/log.ts';

const log = logger('store');

export function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bad = `${file}.corrupt-${stamp}`;
    try {
      fs.renameSync(file, bad);
    } catch {
      /* 留档失败也不能让读路径炸 */
    }
    log.error(`JSON 损坏，已另存留档并回退默认值`, { file, bad, err: String(err) });
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    const old = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(`${file}.bak`, old, 'utf8');
  } catch {
    /* 首次写没有旧文件，正常 */
  }
  fs.renameSync(tmp, file);
}

/**
 * 严格读：解析失败返回 null，**不**把文件改名留档、**不**回退默认值。
 *
 * 给"热加载"用（见 store/watch.ts）：外部（agent/编辑器）可能正写到一半，
 * 这时绝不能把内存里的好配置换成空默认值 —— 那等于"改坏一个文件就把配置清空"。
 * 启动路径继续用宽容的 readJson（坏文件另存留档 + 回退默认值）。
 */
export function readJsonStrict<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as T;
    return parsed ?? null;
  } catch {
    return null;
  }
}

/** 读-改-写 一把梭：调用方拿到最新值，改完返回新值即落盘 */
export function updateJson<T>(file: string, fallback: T, fn: (cur: T) => T): T {
  const next = fn(readJson<T>(file, fallback));
  writeJson(file, next);
  return next;
}

/** 时间戳（毫秒）：各模块统一用它，别各自 new Date() */
export function now(): number {
  return Date.now();
}

/** 短随机 id：给会话/消息/运行用；冲突概率可忽略，且可读性比 uuid 好 */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}
