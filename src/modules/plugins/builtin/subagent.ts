/**
 * src/modules/plugins/builtin/subagent.ts —— 子智能体插件（spawn_agent）。
 *
 * 参照主流做法（Claude Code 的 Task / Codex 的子代理）：
 *  - **默认可写但受限于自己的预算**；要做只读调研时传 read_only=true（不给写工具）；
 *  - **不递归**：子智能体自己拿不到 spawn_agent（防止失控的套娃）；
 *  - **独立上下文**：子智能体只看交办的任务与它自己的工具输出，主会话的历史不带过去；
 *  - **只回传结论**：子智能体的过程留在它自己的转录里（界面上可展开），主循环只收到最后汇报。
 *
 * 真正的循环由运行宿主注入（ctx.runSubagent）——插件层不该知道循环怎么跑，
 * 这样"子智能体"既能复用同一份内核，也不会造成模块循环依赖。
 */
import type { PluginDef, Tool, ToolRunCtx } from '../types.ts';

async function spawnAgent(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const task = String(args.task ?? '').trim();
  if (!task) return { ok: false, text: 'task 必填：把子任务写清楚（目标、已知信息、要什么形式的结论）' };
  if (!ctx.runSubagent) return { ok: false, text: '当前环境不支持子智能体。' };
  const tools = Array.isArray(args.tools) ? args.tools.map((t) => String(t)) : undefined;
  const readOnly = args.read_only === true;
  const maxRounds = Number(args.max_rounds ?? 0) || undefined;
  const res = await ctx.runSubagent(task, { tools, readOnly, maxRounds });
  const head = res.ok ? '子智能体已返回结论' : '子智能体未完成';
  return {
    ok: res.ok,
    text: `${head}（转录运行 ID：${res.runId}）：\n\n${res.text}`,
    note: res.ok ? '子智能体完成' : '子智能体未完成',
    ...(res.runId ? { files: [] } : {}),
  };
}

export const subagentPlugin: Omit<PluginDef, 'tools'> & { tools: Tool[] } = {
  id: 'subagent',
  name: '子智能体',
  desc: '把能独立完成的子任务交出去并行/隔离地做',
  builtin: true,
  promptId: 'plugin.subagent.usage',
  prompt: `子智能体：spawn_agent(task, tools?, read_only?, max_rounds?)。
- 适用：范围明确、结果可一句话带回来的子任务（查资料、批量读文件找线索、独立验证一个假设）。
- 不适用：需要和用户来回确认的事、需要看到主会话上下文的事（它看不到）。
- 子智能体有独立预算、不能再用 spawn_agent；它的转录在界面上单独展开。
- 交办时要写清：目标、已知信息（路径/命令/约束）、期望的结论形式。`,
  params: [],
  tools: [
    {
      name: 'spawn_agent',
      pluginId: 'subagent',
      description: '开一个子智能体做独立的子任务，返回它的结论',
      schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子任务说明（目标 + 已知信息 + 期望结论形式）' },
          tools: { type: 'array', items: { type: 'string' }, description: '只给它的工具名（默认继承，但不含 spawn_agent）' },
          read_only: { type: 'boolean', description: '只读模式：不给任何写/执行类工具' },
          max_rounds: { type: 'number', description: '它最多跑几轮（默认由参数决定）' },
        },
        required: ['task'],
        additionalProperties: false,
      },
      run: spawnAgent,
    },
  ],
};
