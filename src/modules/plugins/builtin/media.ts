/**
 * src/modules/plugins/builtin/media.ts —— 媒体消息插件（需求 2）。
 *
 * 模型用它把**图片 / 视频 / 音频**直接摆到用户眼前：前端拿到工具结果里的媒体信息后
 * 渲染成可见的图或播放器 —— 比只回一句"链接在 https://…"有用得多。
 *
 * 两种来源（都在这里归一）：
 *  · **外部链接**（http/https）：原样交给前端加载（本机服务如 ComfyUI 的 http://127.0.0.1:8188 也算）；
 *  · **本机文件**：复制进待下载目录，交给前端用 /api/downloads/file?inline=1 渲染。
 *    为什么不在这里拼完整 URL：那个接口要登录令牌，而令牌只存在于**浏览器**里
 *    （服务端不持有它）—— 所以这里只给"待下载目录里的文件名"，由前端用 fileUrl() 补令牌。
 *
 * 非媒体文件（zip/pdf/txt）仍然走 deliver_file；这条只负责"看得见"的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PluginDef, Tool, ToolRunCtx } from '../types.ts';
import { DOWNLOADS_DIR } from '../../../util/paths.ts';

const KIND_BY_EXT: Record<string, 'image' | 'video' | 'audio'> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.svg': 'image', '.avif': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video', '.m4v': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.m4a': 'audio', '.flac': 'audio', '.aac': 'audio',
};

function detectKind(target: string, given: unknown): 'image' | 'video' | 'audio' {
  if (given === 'image' || given === 'video' || given === 'audio') return given;
  // 链接可能带查询串（?filename=x.png&type=output），先剥掉再取扩展名
  const clean = target.split('?')[0]!.split('#')[0]!;
  return KIND_BY_EXT[path.extname(clean).toLowerCase()] ?? 'image';
}

function uniqueName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${base}-${i++}${ext}`;
  return candidate;
}

async function sendMedia(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const raw = String(args.url ?? args.path ?? '').trim();
  if (!raw) return { ok: false, text: 'send_media 需要 url（http/https 链接，或本机文件路径）' };
  const caption = typeof args.caption === 'string' ? args.caption.trim() : '';

  if (/^https?:\/\//i.test(raw)) {
    const kind = detectKind(raw, args.kind);
    return {
      ok: true,
      text: `已把${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}摆到用户眼前：${raw}${caption ? `\n图注：${caption}` : ''}`,
      note: `媒体（${kind}）`,
      media: [{ kind, url: raw, ...(caption ? { caption } : {}) }],
    };
  }

  // 本机文件：先看存在与否，再拷进待下载目录
  const abs = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
  if (!fs.existsSync(abs)) return { ok: false, text: `文件不存在：${abs}（要发外部链接就传 http(s) 开头的 url）` };
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return { ok: false, text: `${abs} 是目录；媒体只能一个个发。` };
  const kind = detectKind(abs, args.kind);
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const name = uniqueName(DOWNLOADS_DIR, String(args.name ?? path.basename(abs)));
  fs.copyFileSync(abs, path.join(DOWNLOADS_DIR, name));
  return {
    ok: true,
    text: `已把${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}摆到用户眼前：${name}（${(stat.size / 1024).toFixed(1)} KB，已复制到待下载目录）${caption ? `\n图注：${caption}` : ''}`,
    note: `媒体（${kind}）`,
    // 只给 media，不再给 files：媒体卡自己带"打开"链接，两样都给会渲染两遍（同一份东西）
    media: [{ kind, download: name, ...(caption ? { caption } : {}) }],
  };
}

export const mediaPlugin: Omit<PluginDef, 'tools'> & { tools: Tool[] } = {
  id: 'media',
  name: '媒体消息',
  desc: '把图片/视频/音频直接摆到用户眼前（渲染成可见的图或播放器）',
  builtin: true,
  promptId: 'plugin.media.usage',
  prompt: `媒体消息：send_media(url, kind?, caption?, name?)。
- 产出是**图片/视频/音频**时用它（截图、生成的图、录制的视频、音频片段），
  比只回一个链接有用得多 —— 用户会直接看到图/播放器。
- 外部链接（http/https）直接传；**本机文件**传路径，会先复制进待下载目录再渲染。
- kind 一般不用传（按扩展名自动判断）；caption 是图注；name 只在改文件名时传。
- 非媒体的产出（zip、pdf、txt、代码）仍然用 deliver_file。`,
  params: [],
  tools: [
    {
      name: 'send_media',
      pluginId: 'media',
      description: '把图片/视频/音频（链接或本机文件）渲染到会话里给用户看',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http/https 链接，或本机文件路径' },
          kind: { type: 'string', enum: ['image', 'video', 'audio'], description: '媒体类型（默认按扩展名判断）' },
          caption: { type: 'string', description: '图注（显示在媒体下方）' },
          name: { type: 'string', description: '本机文件复制到待下载目录时用的文件名' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      run: sendMedia,
    },
  ],
};
