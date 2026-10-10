/**
 * src/modules/plugins/builtin/skill-tools.ts —— 技能插件（技能模块的"可执行命令"那一半）。
 *
 * 技能走渐进式披露：目录（name + description）常驻系统提示词，全文靠 use_skill 载入。
 * 这样技能写到 50 个也不会把上下文挤爆 —— 主流 harness（Claude Skills 等）的做法。
 */
import * as skills from '../../skills/index.ts';
import type { PluginDef, Tool, ToolRunCtx } from '../types.ts';

async function useSkill(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const name = String(args.name ?? '').trim();
  if (!name) return { ok: false, text: 'name 必填（用 list_skills 看有哪些）' };
  const skill = skills.load(name);
  if (!skill) {
    const all = skills.list().map((s) => s.name);
    return { ok: false, text: `没有叫「${name}」的技能。现有：${all.join(', ') || '（无）'}` };
  }
  const files = skill.files.length ? `\n\n附属文件（相对技能目录）：\n${skill.files.map((f) => `- ${f}`).join('\n')}` : '';
  const hint = ctx.prompt('skills.use.hint', { name: skill.name, dir: skill.dir });
  return {
    ok: true,
    text: `# 技能：${skill.name}\n${skill.description}\n\n${skill.body}${files}\n\n${hint}`,
    note: `载入技能 ${skill.name}`,
  };
}

async function listSkills(_args: Record<string, unknown>, _ctx: ToolRunCtx) {
  const all = skills.list();
  if (!all.length) return { ok: true, text: '（还没有技能）', note: '0 个技能' };
  return {
    ok: true,
    text: all.map((s) => `- ${s.name}${s.enabled ? '' : '（已停用）'}：${s.description}`).join('\n'),
    note: `${all.length} 个技能`,
  };
}

async function skillWrite(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const name = String(args.name ?? '').trim();
  const description = String(args.description ?? '').trim();
  const body = String(args.body ?? '').trim();
  if (!name || !description || !body) return { ok: false, text: 'name / description / body 都是必填（要求见提示词：description 要写"什么时候用"）' };
  const meta = skills.write({ name, description, body });
  return {
    ok: true,
    text: `技能已保存：${meta.name}（${meta.dir}/SKILL.md）。下次遇到同类任务时它就在目录里。`,
    note: `存技能 ${meta.name}`,
    refreshPrompt: true,
  };
}

async function skillRead(args: Record<string, unknown>, ctx: ToolRunCtx) {
  return useSkill(args, ctx);
}

async function skillDelete(args: Record<string, unknown>, _ctx: ToolRunCtx) {
  const name = String(args.name ?? '').trim();
  if (!name) return { ok: false, text: 'name 必填' };
  const ok = skills.remove(name);
  return ok
    ? { ok: true, text: `技能 ${name} 已删除（进了 .trash，可人工恢复）`, note: `删技能 ${name}`, refreshPrompt: true }
    : { ok: false, text: `没有叫 ${name} 的技能` };
}

async function skillImport(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const src = String(args.path ?? '').trim();
  if (!src) return { ok: false, text: 'path 必填（目录或 .md 文件）' };
  const abs = src.startsWith('/') ? src : `${ctx.cwd}/${src}`;
  const fsmod = await import('node:fs');
  const stat = fsmod.default.statSync(abs);
  const imported = stat.isDirectory()
    ? skills.importDir(abs)
    : [skills.importMarkdown(fsmod.default.readFileSync(abs, 'utf8'))];
  if (!imported.length) return { ok: false, text: `没从 ${abs} 里找到 SKILL.md 或 *.md` };
  return {
    ok: true,
    text: `已导入 ${imported.length} 个技能：${imported.map((s) => s.name).join(', ')}`,
    note: `导入 ${imported.length} 个`,
    refreshPrompt: true,
  };
}

function schemaOf(props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

export const skillPlugin: Omit<PluginDef, 'tools'> & { tools: Tool[] } = {
  id: 'skills',
  name: '技能',
  desc: '把成熟做法沉成技能，下次直接复用',
  builtin: true,
  promptId: 'plugin.skills.usage',
  prompt: `技能：use_skill / list_skills / skill_write / skill_read / skill_delete / skill_import。
- 目录在上方"技能"章节里；要做某类任务前先扫一眼有没有现成方法。
- 第一次做好某类任务（尤其是多步骤、有坑的）后，用 skill_write 把做法沉淀下来，下次省时间。
- 技能正文用 SKILL.md 格式，≤500 行；长细节放到技能目录里的参考文件。`,
  params: [],
  tools: [
    {
      name: 'use_skill',
      pluginId: 'skills',
      description: '载入一个技能的全文（技能目录里看到的做法，用它拿到步骤）',
      schema: schemaOf({ name: { type: 'string', description: '技能名' } }, ['name']),
      run: useSkill,
    },
    {
      name: 'list_skills',
      pluginId: 'skills',
      description: '列出全部技能（名称 + 说明）',
      schema: schemaOf({}, []),
      run: listSkills,
    },
    {
      name: 'skill_write',
      pluginId: 'skills',
      description: '新建或更新一个技能（把成熟做法沉淀下来）',
      schema: schemaOf(
        {
          name: { type: 'string', description: '技能名（小写字母/数字/连字符）' },
          description: { type: 'string', description: '做什么 + 什么时候用' },
          body: { type: 'string', description: '正文（步骤、命令、坑、验证方式）' },
        },
        ['name', 'description', 'body'],
      ),
      run: skillWrite,
    },
    {
      name: 'skill_read',
      pluginId: 'skills',
      description: '读一个技能的全文（与 use_skill 等价）',
      schema: schemaOf({ name: { type: 'string' } }, ['name']),
      run: skillRead,
    },
    {
      name: 'skill_delete',
      pluginId: 'skills',
      description: '删除一个技能（进 .trash 可恢复）',
      schema: schemaOf({ name: { type: 'string' } }, ['name']),
      run: skillDelete,
    },
    {
      name: 'skill_import',
      pluginId: 'skills',
      description: '从目录或 Markdown 文件导入技能（认 SKILL.md）',
      schema: schemaOf({ path: { type: 'string', description: '目录（含 <名>/SKILL.md）或单个 .md' } }, ['path']),
      run: skillImport,
    },
  ],
};
