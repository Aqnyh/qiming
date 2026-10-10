/**
 * ui/lib/format.js —— 展示用的格式化：字节、时间、时长、字数、文件类型。
 *
 * 为什么集中一处：消息区、待办、待下载三处都要用这些，
 * 各写一份就会出现"同一个字节数两处显示不一样"的老问题。
 */

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function two(n) {
  return String(n).padStart(2, '0');
}

export function fmtClock(ts) {
  const d = new Date(Number(ts) || 0);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 相对时间：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / M月D日 */
export function fmtWhen(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const now = Date.now();
  const diff = now - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(t);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return fmtClock(t);
  const y = new Date(now - 86400_000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${fmtClock(t)}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtDuration(ms) {
  const v = Number(ms) || 0;
  if (v < 1000) return `${Math.round(v)} 毫秒`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)} 秒`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return `${m} 分 ${s} 秒`;
}

/** 思考/结果的字数：过万换"万字"，避免一长串数字占满一行 */
export function fmtChars(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万字`;
  return `${v} 字`;
}

export function fmtCount(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

export function baseName(p) {
  const s = String(p ?? '');
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']);
const TEXT = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yml', 'yaml', 'ts', 'js', 'tsx', 'jsx', 'py', 'sh', 'html', 'css']);

/** 文件大类（决定内联预览还是给下载链接） */
export function fileKind(name) {
  const e = extOf(name);
  if (IMAGE.has(e)) return 'image';
  if (VIDEO.has(e)) return 'video';
  if (AUDIO.has(e)) return 'audio';
  if (TEXT.has(e)) return 'text';
  return 'other';
}

/** 一行统计：token 与用时（消息元信息用） */
export function statsLine(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.in || stats.out) parts.push(`↑${fmtCount(stats.in)} ↓${fmtCount(stats.out)} tokens`);
  if (stats.ms) parts.push(fmtDuration(stats.ms));
  return parts.join(' · ');
}
