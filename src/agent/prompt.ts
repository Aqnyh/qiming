/**
 * src/agent/prompt.ts —— 系统提示词组装（纯函数，好测）。
 *
 * 顺序即优先级（模型对靠前的内容更"当回事"）：
 *   1) 系统基础三段（身份 / 输出格式 / 工具使用）
 *   2) 环境事实（本机账号、工作目录、项目、模型、时间）
 *   3) 插件章节（启用插件的用法说明）
 *   4) 外部资源章节（接了哪些外部能力、工具名、状态）
 *   5) 技能目录（name + description，渐进式披露）
 *   6) 记忆索引（标题 + 摘要；全文按需读）
 *
 * 每一步都可能为空；空则不出现标题（不要留一堆空章节占上下文）。
 */
import type { PromptRegistry } from '../modules/prompts/registry.ts';
import type { PluginView } from '../modules/plugins/registry.ts';

export type ResourceLine = { name: string; desc: string; state: string; detail: string; tools: string[] };

export type SystemInput = {
  prompts: PromptRegistry;
  plugins: PluginView[];
  /** 只有启用的插件才进来；资源插件单独走 resources 参数 */
  resources: ResourceLine[];
  memory: { global: string[]; project: string[] | null; projectName?: string };
  skills: string[];
  env: {
    user: string;
    cwd: string;
    projectName?: string;
    model: string;
    provider: string;
    now: string;
  };
};

export function assembleSystem(input: SystemInput): string {
  const p = input.prompts;
  const blocks: string[] = [];

  for (const id of ['system.base', 'system.output', 'system.tools', 'system.modules', 'system.self']) {
    if (!p.enabled(id)) continue;
    const t = p.text(id).trim();
    if (t) blocks.push(t);
  }

  blocks.push(envBlock(input.env));

  const pluginBlocks = input.plugins
    .filter((pl) => pl.enabled && pl.prompt.trim())
    .map((pl) => `### ${pl.name}\n${pl.prompt.trim()}`);
  if (pluginBlocks.length) blocks.push(`## 插件（可执行的命令）\n${pluginBlocks.join('\n\n')}`);

  if (input.resources.length || p.enabled('res.intro')) {
    const lines = input.resources.map((r) => {
      const tools = r.tools.length ? `\n  工具：${r.tools.join(', ')}` : '';
      const state = r.state === 'ready' ? '可用' : `状态：${r.detail}`;
      return `- ${r.name}（${state}）：${r.desc}${tools}`;
    });
    const intro = p.enabled('res.intro') ? p.text('res.intro').trim() : '';
    const body = lines.length ? lines.join('\n') : p.text('res.empty').trim();
    if (intro || body) blocks.push(`${intro}\n${body}`.trim());
  }

  if (p.enabled('skills.index.intro')) {
    const body = input.skills.length ? input.skills.join('\n') : p.text('skills.empty').trim();
    blocks.push(`${p.text('skills.index.intro').trim()}\n${body}`);
  }

  const memLines: string[] = [];
  if (input.memory.project) {
    const intro = p.text('memory.project.intro', { project: input.memory.projectName ?? '' }).trim();
    const usage = p.enabled('memory.project.usage') ? p.text('memory.project.usage').trim() : '';
    const body = input.memory.project.length ? input.memory.project.join('\n') : p.text('memory.empty').trim();
    memLines.push(`${intro}\n${body}${usage ? `\n${usage}` : ''}`);
  }
  if (input.memory.global.length || (!input.memory.project && p.enabled('memory.index.intro'))) {
    const intro = p.text('memory.index.intro').trim();
    const body = input.memory.global.length ? input.memory.global.join('\n') : p.text('memory.empty').trim();
    memLines.push(`${intro}\n${body}`);
  }
  if (memLines.length) blocks.push(memLines.join('\n\n'));

  if (p.enabled('memory.write.hint')) blocks.push(p.text('memory.write.hint').trim());

  return blocks.filter(Boolean).join('\n\n---\n\n');
}

function envBlock(env: SystemInput['env']): string {
  const lines = [
    '## 运行环境',
    `- 本机账号：${env.user}（命令以它执行；需要 root 时用 sudo，已具备权限）`,
    `- 工作目录：${env.cwd}`,
  ];
  if (env.projectName) lines.push(`- 当前项目：${env.projectName}`);
  lines.push(`- 当前模型：${env.provider} / ${env.model}`);
  lines.push(`- 现在：${env.now}`);
  return lines.join('\n');
}
