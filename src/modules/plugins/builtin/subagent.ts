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
  if (!task) return { ok: false, errorCode: 'INVALID_ARGS' as const, text: 'task 必填：把子任务写清楚（目标、已知信息、要什么形式的结论）' };
  if (!ctx.runSubagent) return { ok: false, text: '当前环境不支持子智能体。' };
  const tools = Array.isArray(args.tools) ? args.tools.map((t) => String(t)) : undefined;
  const readOnly = args.read_only === true;
  const maxRounds = Number(args.max_rounds ?? 0) || undefined;
  const res = await ctx.runSubagent(task, { tools, readOnly, maxRounds });
  const head = res.ok ? '子智能体已返回结论' : '子智能体未完成';
  return {
    ok: res.ok,
    text: `${head}（转录运行 ID：${res.runId}${res.id ? `，子体 id：${res.id}` : ''}）：\n\n${res.text}`,
    note: res.ok ? '子智能体完成' : '子智能体未完成',
    ...(res.runId ? { files: [] } : {}),
  };
}

/** 给某个子智能体再发一句话，它带着自己的历史接着做（可续） */
async function subagentSend(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const id = String(args.id ?? '').trim();
  const text = String(args.text ?? '').trim();
  if (!id || !text) return { ok: false, errorCode: 'INVALID_ARGS' as const, text: 'id 与 text 必填' };
  if (!ctx.subagents) return { ok: false, text: '当前环境不支持子智能体控制面。' };
  const res = await ctx.subagents.send(id, text);
  return {
    ok: res.ok,
    text: `子智能体 ${id} ${res.ok ? '已回复' : '未完成'}：\n\n${res.text}`,
    note: res.ok ? '续谈完成' : '续谈未完成',
  };
}

async function subagentStop(args: Record<string, unknown>, ctx: ToolRunCtx) {
  const id = String(args.id ?? '').trim();
  if (!id) return { ok: false, errorCode: 'INVALID_ARGS' as const, text: 'id 必填' };
  if (!ctx.subagents) return { ok: false, text: '当前环境不支持子智能体控制面。' };
  const ok = ctx.subagents.stop(id);
  return { ok, text: ok ? `已中断子智能体 ${id} 当前那一段。` : `子智能体 ${id} 没有在跑，无需中断。` };
}

async function subagentList(_args: Record<string, unknown>, ctx: ToolRunCtx) {
  if (!ctx.subagents) return { ok: false, text: '当前环境不支持子智能体控制面。' };
  const list = ctx.subagents.list();
  if (!list.length) return { ok: true, text: '（本次会话还没有开过子智能体）', note: '0 个' };
  const lines = list.map((s) => `- ${s.id} · ${s.status} · ${s.runs} 段 · ${s.task}${s.finalText ? `\n    最近结论：${s.finalText.slice(0, 160)}` : ''}`);
  return { ok: true, text: `子智能体（${list.length}）：\n${lines.join('\n')}`, note: `${list.length} 个` };
}

export const subagentPlugin: Omit<PluginDef, 'tools'> & { tools: Tool[] } = {
  id: 'subagent',
  name: '子智能体',
  desc: '把能独立完成的子任务交出去并行/隔离地做，可续谈、可中断、可列举',
  builtin: true,
  promptId: 'plugin.subagent.usage',
  prompt: `子智能体：
- spawn_agent(task, tools?, read_only?, max_rounds?) 开一个新的子体做独立子任务，返回结论。
  · 适用：范围明确、结果可一句话带回来的子任务（查资料、批量读文件找线索、独立验证一个假设）。
  · 不适用：需要和用户来回确认的事、需要看到主会话上下文的事（它看不到）。
  · 子智能体有独立预算、不能再用 spawn_agent；它的转录在界面上单独展开。
  · 交办时要写清：目标、已知信息（路径/命令/约束）、期望的结论形式。
- subagent_send(id, text) 给已存在的子体**再发一句话**，它带着自己的历史接着做（续谈，不丢上文）。
- subagent_stop(id) 中断某个子体当前那一段（它已经产出的内容留档）。
- subagent_list() 列出这次会话开过的子体与各自状态（可审计）。`,
  /* 子智能体的**默认轮次上限**：优先级是 工具入参 max_rounds → 这里的 max_rounds → 12
     （见 agent/rounds.ts）。子智能体的预算属于插件自己的参数（设置 → 插件 → 子智能体），
     不再放在系统设置里 —— 2026-10-10 第十一轮归一。**不设硬上限**：填多少就是多少。 */
  params: [{ key: 'max_rounds', name: '子智能体默认轮次上限（0 = 内置默认 12）', type: 'number', def: 0 }],
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
    {
      name: 'subagent_send',
      pluginId: 'subagent',
      description: '给已存在的子智能体续谈：它带着自己的历史继续做，不丢上文',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '子智能体 id（spawn_agent 的返回里给了）' },
          text: { type: 'string', description: '要接着问/接着做的事' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      run: subagentSend,
    },
    {
      name: 'subagent_stop',
      pluginId: 'subagent',
      description: '中断某个子智能体当前那一段（已产出的内容留档）',
      schema: {
        type: 'object',
        properties: { id: { type: 'string', description: '子智能体 id' } },
        required: ['id'],
        additionalProperties: false,
      },
      run: subagentStop,
    },
    {
      name: 'subagent_list',
      pluginId: 'subagent',
      description: '列出这次会话开过的子智能体与各自状态',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      run: subagentList,
    },
  ],
};
