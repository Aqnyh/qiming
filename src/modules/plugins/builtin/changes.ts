/**
 * src/modules/plugins/builtin/changes.ts —— 文件改动的比对与撤回（changes 插件）。
 *
 * 三个工具，对应"改完文件之后你会想做的三件事"：
 *   changes_list    —— 这次会话都改了什么（列表 + 每个文件的增删行数）；
 *   changes_diff    —— 某一个文件的统一 diff（-/+ 逐行对比）；
 *   changes_restore —— 撤回到某个检查点（回到"那次改动动手前"的样子）。
 *
 * 与 fs 插件的分工：fs 负责"写"，并在写之前让 store/checkpoints.ts 记一笔快照；
 * 这里负责"看"和"退"。两边共享同一个影子 git 仓库（ToolRunCtx.changes）。
 *
 * 为什么带回执而不返回裸文本：撤回是**破坏性**操作（会删掉快照之后新建的文件），
 * 模型必须看到"到底动了哪些文件"才能如实向用户交代 —— 所以回执里把 files/removed 都列出来。
 */
import path from 'node:path';
import type { PluginDef, Tool, ToolRunCtx } from '../types.ts';

const MAX_DIFF_CHARS = 20_000;

function relTo(cwd: string, p: string): string {
  const r = path.relative(cwd, path.isAbsolute(p) ? p : path.resolve(cwd, p));
  return r.startsWith('..') ? p : r;
}

function fmtWhen(ts: number): string {
  const d = new Date(Number(ts) || 0);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

async function changesList(args: Record<string, unknown>, ctx: ToolRunCtx) {
  if (!ctx.changes) return { ok: false, text: '当前会话没有可用的改动记录（检查点仓库未启用）。' };
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20) || 20));
  /* 两个视角一次给全：
     · 检查点列表 = "每次改动动手前的样子"（撤回的锚点）；
     · 当前未快照的改动 = "现在还没被记下来的"（正在改的过程中看它）。 */
  const list = await ctx.changes.list();
  const now = await ctx.changes.diff();

  const lines: string[] = [];
  if (list.length) {
    lines.push(`## 检查点（共 ${list.length} 条，新→旧；id 用于 changes_restore）`);
    for (const cp of list.slice(0, limit)) {
      const stat = cp.added !== undefined ? ` +${cp.added}−${cp.removed ?? 0}` : '';
      const files = cp.files.length ? ` · ${cp.files.map((f) => relTo(ctx.cwd, f)).slice(0, 4).join(', ')}` : '';
      lines.push(`- \`${cp.id}\` ${fmtWhen(cp.ts)} ${cp.label}${stat}${files}`);
    }
  } else {
    lines.push('## 检查点\n（还没有。写文件/改文件时会自动记，之后这里就能看到改动历史）');
  }
  if (now.stat.files) {
    lines.push('', `## 还没被记下来的改动（${now.stat.files} 个文件，+${now.stat.added}−${now.stat.removed}）`);
    lines.push('（写文件/改文件前后都会自动记一笔，所以这里通常是"正在改动中"的短暂状态；'
      + '想看**某一次改动具体改了什么**，用 changes_diff(checkpoint=<上面某个 id>)）');
    for (const it of now.stat.list.slice(0, limit)) lines.push(`- ${it.path} +${it.added}−${it.removed}`);
  }
  return {
    ok: true,
    text: lines.join('\n'),
    note: `检查点 ${list.length} 条${now.stat.files ? ` · 未记录 ${now.stat.files} 个文件` : ''}`,
  };
}

async function changesDiff(args: Record<string, unknown>, ctx: ToolRunCtx) {
  if (!ctx.changes) return { ok: false, text: '当前会话没有可用的改动记录（检查点仓库未启用）。' };
  const file = args.path ? String(args.path).trim() : '';
  const id = args.checkpoint ? String(args.checkpoint).trim() : '';
  /* 两种问法：
     · 给了 checkpoint → 看**那一次改动本身**改了什么（比它的下一个快照，最新那条比当前工作树）；
     · 没给 → 看"现在还没被记下来的改动"（正在改的过程中看它）。 */
  if (id) {
    const s = await ctx.changes.show(id, file || undefined);
    if (!s.stat.files) {
      const list = await ctx.changes.list();
      if (!list.some((c) => c.id === id)) {
        return { ok: false, text: `没有检查点 ${id}。用 changes_list 看有哪些（id 是 12 位十六进制）。` };
      }
      return { ok: true, text: `检查点 ${id} 之后没有文件差异（可能是"撤回前备份"这类系统快照，或改动已被后续操作覆盖）。` };
    }
    return { ok: true, text: renderDiff(`## 检查点 ${id} 的改动`, s), note: `${id} · ${s.stat.files} 个文件 +${s.stat.added}−${s.stat.removed}` };
  }

  const d = await ctx.changes.diff();
  if (!d.stat.files) {
    const list = await ctx.changes.list();
    const hint = list.length
      ? `最近一条检查点：\`${list[0]!.id}\` ${list[0]!.label} —— 想看它改了什么就传 checkpoint=${list[0]!.id}。`
      : '（还没有任何检查点）';
    return { ok: true, text: `当前没有"尚未记入检查点的改动"（改动一写完就会自动记进检查点）。${hint}`, note: '当前无未记录改动' };
  }
  let picked = d.stat.list;
  let text = d.text;
  if (file) {
    const want = relTo(ctx.cwd, file);
    const blocks = text.split(/(?=^diff --git )/m);
    const hit = blocks.find((b) => b.startsWith(`diff --git a/${want}`));
    if (!hit) return { ok: false, text: `${want} 没有未记录的改动。有改动的文件：${d.stat.list.map((x) => x.path).join(', ')}` };
    text = hit;
    picked = d.stat.list.filter((x) => x.path === want);
  }
  const head =
    picked.length === 1
      ? `## ${picked[0]!.path}  +${picked[0]!.added}−${picked[0]!.removed}（尚未记入检查点）`
      : `## 尚未记入检查点的改动（${d.stat.files} 个文件，+${d.stat.added}−${d.stat.removed}）`;
  return { ok: true, text: renderDiff(head, { text, stat: d.stat }), note: `${picked.length} 个文件 +${d.stat.added}−${d.stat.removed}` };
}

/** diff 文本统一渲染（截断 + diff 代码块），避免两个分支各写一遍 */
function renderDiff(head: string, d: { text: string; stat: { files: number } }): string {
  const clipped =
    d.text.length > MAX_DIFF_CHARS
      ? `${d.text.slice(0, MAX_DIFF_CHARS)}\n…（diff 太长已截断，共 ${d.text.length} 字；用 path 参数只看某个文件）`
      : d.text;
  return `${head}\n\n\`\`\`diff\n${clipped}\n\`\`\``;
}

async function changesRestore(args: Record<string, unknown>, ctx: ToolRunCtx) {
  if (!ctx.changes) return { ok: false, text: '当前会话没有可用的改动记录（检查点仓库未启用）。' };
  const id = String(args.checkpoint ?? '').trim();
  if (!id) return { ok: false, text: 'checkpoint 必填：先用 changes_list 看有哪些检查点（形如 a1b2c3d4e5f6）。' };
  const r = await ctx.changes.restore(id);
  if (!r.ok) return { ok: false, text: r.detail };
  const lines = [
    r.detail,
    '',
    '恢复后的工作树已作为**新检查点**记下（历史不会被抹掉），所以这一步本身也能再撤回。',
  ];
  if (r.removed.length) {
    lines.push('', `移除的快照之后新增的文件（共 ${r.removed.length} 个）：`);
    for (const f of r.removed.slice(0, 20)) lines.push(`- ${f}`);
  }
  return {
    ok: true,
    text: lines.join('\n'),
    note: `已撤回 → ${id}`,
    lines: { added: 0, removed: 0 },
  };
}

export const changesPlugin: Omit<PluginDef, 'tools'> & { tools: Tool[] } = {
  id: 'changes',
  name: '改动比对与撤回',
  desc: '列出/对比/撤回本次会话对文件的改动（影子 git 检查点）',
  builtin: true,
  promptId: 'plugin.changes.usage',
  prompt: `改动比对与撤回：changes_list(limit?) / changes_diff(path?, checkpoint?) / changes_restore(checkpoint)。
- 每次 read/write/edit/delete 之前会自动打一个快照；**改完想确认或反悔就用这三个工具**，不要凭记忆。
- 交付前如果改过关键文件，用 changes_diff 复看一眼 diff 再下结论（改错了当场能发现）。
- 用户说"撤销/回退/改坏了"时：先 changes_list 找到改动前那条检查点，再 changes_restore。撤回是破坏性的（会删掉快照之后新建的文件），做完要如实告诉用户动了哪些文件。`,
  params: [],
  tools: [
    {
      name: 'changes_list',
      pluginId: 'changes',
      description: '列出本次会话的检查点（改动历史）与尚未记录的改动',
      schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: '最多列几条（默认 20）' } },
        additionalProperties: false,
      },
      run: changesList,
    },
    {
      name: 'changes_diff',
      pluginId: 'changes',
      description: '看某次改动的统一 diff（可比某个文件，也可比某个检查点之后的所有改动）',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '只看这个文件（相对工作目录或绝对路径）' },
          checkpoint: { type: 'string', description: '相对这个检查点比较（默认与最新检查点比）' },
        },
        additionalProperties: false,
      },
      run: changesDiff,
    },
    {
      name: 'changes_restore',
      pluginId: 'changes',
      description: '撤回到某个检查点（回到那次改动之前的样子；会移除之后新建的文件）',
      schema: {
        type: 'object',
        properties: { checkpoint: { type: 'string', description: '检查点 id（changes_list 里那一列）' } },
        required: ['checkpoint'],
        additionalProperties: false,
      },
      run: changesRestore,
    },
  ],
};
