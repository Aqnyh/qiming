/**
 * src/store/watch.ts —— 配置文件热加载（轮询式）。
 *
 * 为什么需要它：agent 可以直接改 `data/*.json` 来给自己加插件/资源/提示词
 * （需求 3"直接通过改文件的方式来实现新增、修改"），改完必须**立刻生效**，
 * 而不是"重启服务才生效"—— 那就不是"能自己扩展"了。
 *
 * 为什么用轮询而不是 fs.watch：数据目录在 NTFS 挂载上（ntfs-3g），
 * inotify 事件在这类文件系统上不可靠（编辑器的"写临时文件再改名"也可能漏事件）。
 * 三个文件的 stat 每 2 秒一次，成本可以忽略。
 *
 * 两条防呆：
 *  1. **写入中不读**：文件刚被改过（mtime 距现在 < settleMs）就跳过这一轮，
 *     否则可能读到只写了一半的 JSON；
 *  2. 解析失败**保留旧状态**（由调用方的 reload 返回 false 决定），
 *     绝不因为一次半截写入就把用户的配置清空。
 */
import fs from 'node:fs';

export type WatchHandle = { stop: () => void };

export function watchFiles(
  files: string[],
  onChange: (file: string) => void,
  opts: { intervalMs?: number; settleMs?: number } = {},
): WatchHandle {
  const intervalMs = opts.intervalMs ?? 2000;
  const settleMs = opts.settleMs ?? 1500;
  const seen = new Map<string, string>();

  const stamp = (file: string): string | null => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };

  // 首轮只记录基线，不触发（服务启动时不算"外部修改"）
  for (const f of files) {
    const s = stamp(f);
    if (s) seen.set(f, s);
  }

  const timer = setInterval(() => {
    for (const file of files) {
      const cur = stamp(file);
      if (!cur) continue;
      const prev = seen.get(file);
      if (prev === cur) continue;
      // 刚写过的先等等（可能还在写），下一轮再认
      const mtime = Number(cur.split(':')[0]);
      if (Date.now() - mtime < settleMs) continue;
      seen.set(file, cur);
      onChange(file);
    }
  }, intervalMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
