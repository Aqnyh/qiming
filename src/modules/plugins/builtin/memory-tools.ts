/**
 * src/modules/plugins/builtin/memory-tools.ts —— 记忆插件（记忆模块的"可执行命令"那一半）。
 *
 * 记忆的读写都落成 Markdown 文件（见 modules/memory），这里的工具只是把它交给模型。
 * 关键纪律：**改完必须已经落盘才算成功**（旧项目踩过"谎报成功"的坑：
 * 模型以为记下了、下一轮读不到，于是反复重试）。
 */
import * as memory from '../../memory/index.ts';
import type { PluginDef, Tool, ToolRunCtx } from '../types.ts';

function scopeOf(ctx: ToolRunCtx, raw: unknown): memory.Scope {
  const want = String(raw ?? '').trim();
  if (want === 'global') return { kind: 'global' };
  if (want.startsWith('project')) {
    if (!ctx.project) throw new Error('当前会话没有绑定项目，项目记忆不可用；要记就记全局（scope=global）或先选项目。');
    return { kind: 'project', id: ctx.project.id, name: ctx.project.name };
  }
  // 缺省：有项目写项目，没项目写全局（模型不用记这个规则，提示词里说了）
  if (ctx.project) return { kind: 'project', id: ctx.project.id, name: ctx.project.name };
  return { kind: 'global' };
}

async function memoryWrite(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const title = String(args.title ?? '').trim();
  const content = String(args.content ?? '').trim();
  if (!title || !content) return { ok: false, text: 'title 与 content 都是必填' };
  const scope = scopeOf(ctx, args.scope);
  const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : [];
  const entry = memory.writeEntry(scope, {
    slug: typeof args.slug === 'string' ? args.slug : undefined,
    title,
    description: typeof args.description === 'string' ? args.description : undefined,
    body: content,
    tags,
  });
  const saved = memory.readEntry(scope, entry.slug);
  if (!saved) return { ok: false, text: '写入后读不回来，落盘失败（请检查数据目录权限）' };
  return {
    ok: true,
    text: `已记住（${saved.scopeLabel}）：${saved.title}（${saved.slug}）`,
    note: `记：${saved.title}`,
    refreshPrompt: true,
  };
}

async function memorySearch(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const query = String(args.query ?? '').trim();
  const scope = args.scope ? scopeOf(ctx, args.scope) : null;
  const results = scope ? memory.search(scope, query, Number(args.limit ?? 10)) : [
    ...memory.search({ kind: 'global' }, query, Number(args.limit ?? 10)),
    ...(ctx.project ? memory.search({ kind: 'project', id: ctx.project.id, name: ctx.project.name }, query, Number(args.limit ?? 10)) : []),
  ];
  if (!results.length) return { ok: true, text: `没有匹配「${query}」的记忆。`, note: '无命中' };
  const text = results
    .map((e) => `## ${e.title}（${e.slug}｜${e.scopeLabel}）\n${e.description}\n\n${e.body.slice(0, 1200)}${e.body.length > 1200 ? '\n…（截断，用 memory_read 看全文）' : ''}`)
    .join('\n\n---\n\n');
  return { ok: true, text, note: `${results.length} 条命中` };
}

async function memoryRead(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const slug = String(args.slug ?? args.name ?? '').trim();
  if (!slug) return { ok: false, text: 'slug 必填' };
  const scopes: memory.Scope[] = args.scope
    ? [scopeOf(ctx, args.scope)]
    : [{ kind: 'global' }, ...(ctx.project ? [{ kind: 'project' as const, id: ctx.project.id, name: ctx.project.name }] : [])];
  for (const scope of scopes) {
    const entry = memory.readEntry(scope, slug);
    if (entry) {
      return {
        ok: true,
        text: `# ${entry.title}（${entry.scopeLabel}｜${entry.slug}）\n标签：${entry.tags.join(', ') || '无'}\n\n${entry.body}`,
        note: `读：${entry.title}`,
      };
    }
  }
  return { ok: false, text: `没有叫 ${slug} 的记忆。可先用 memory_search 找。` };
}

async function memoryForget(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const slug = String(args.slug ?? '').trim();
  if (!slug) return { ok: false, text: 'slug 必填' };
  const scope = scopeOf(ctx, args.scope);
  const ok = memory.removeEntry(scope, slug);
  return ok
    ? { ok: true, text: `已删除记忆 ${slug}（进了 .trash，可人工恢复）`, note: `删：${slug}`, refreshPrompt: true }
    : { ok: false, text: `没找到 ${slug}` };
}

function schemaOf(props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

export const memoryPlugin: Omit<PluginDef, 'tools'> & { tools: Tool[] } = {
  id: 'memory',
  name: '记忆',
  desc: '记下长期有效的事实，跨会话复用',
  builtin: true,
  promptId: 'plugin.memory.usage',
  prompt: `记忆：memory_write / memory_search / memory_read / memory_forget。
- 记什么：用户偏好与约定、环境事实（路径/端口/账号）、踩过的坑、重要决定。
- 有项目时默认写进项目记忆（跨会话共享）；scope=global 写全局。
- 动手前可以 memory_search 看看有没有相关记录，别重复踩坑。`,
  params: [],
  tools: [
    {
      name: 'memory_write',
      pluginId: 'memory',
      description: '把一条长期有效的事实记进记忆（有项目写项目记忆，否则写全局）',
      schema: schemaOf(
        {
          title: { type: 'string', description: '标题（一句话）' },
          content: { type: 'string', description: '正文：事实本身 + 为什么重要' },
          description: { type: 'string', description: '索引里显示的一行摘要' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          scope: { type: 'string', description: 'global 或 project（默认按当前项目判断）' },
          slug: { type: 'string', description: '文件名（不传按标题生成）' },
        },
        ['title', 'content'],
      ),
      run: memoryWrite,
    },
    {
      name: 'memory_search',
      pluginId: 'memory',
      description: '按关键词搜记忆，返回候选条目的摘要与正文片段',
      schema: schemaOf(
        {
          query: { type: 'string', description: '关键词' },
          scope: { type: 'string', description: '限定 global / project' },
          limit: { type: 'number' },
        },
        ['query'],
      ),
      run: memorySearch,
    },
    {
      name: 'memory_read',
      pluginId: 'memory',
      description: '读某条记忆的完整正文',
      schema: schemaOf({ slug: { type: 'string' }, scope: { type: 'string' } }, ['slug']),
      run: memoryRead,
    },
    {
      name: 'memory_forget',
      pluginId: 'memory',
      description: '删除一条记忆（进 .trash 可恢复）',
      schema: schemaOf({ slug: { type: 'string' }, scope: { type: 'string' } }, ['slug']),
      run: memoryForget,
    },
  ],
};
