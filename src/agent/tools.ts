/**
 * src/agent/tools.ts —— 工具执行层（循环与插件之间的那一层）。
 *
 * 职责只有四件：
 *  1. 按名字找到工具（找不到给模型一句人话，而不是让它猜）；
 *  2. 预算记账（每个插件自己的额度，用户设多少就是多少）；
 *  3. 统一异常出口（工具抛错也要变成"可读的失败结果"，循环不能因为一个工具炸掉）；
 *  4. 结果归一（ok/text/note/lines/files），保证落盘与界面渲染的形状一致。
 */
import type { Tool, ToolResult, ToolRunCtx } from '../modules/plugins/types.ts';
import type { PluginRegistry } from '../modules/plugins/registry.ts';
import type { PromptRegistry } from '../modules/prompts/registry.ts';
import type { Project } from '../store/projects.ts';
import type { Logger } from '../util/log.ts';
import type { ToolDef, ToolCall } from '../providers/types.ts';

export type ExecutorDeps = {
  plugins: PluginRegistry;
  prompts: PromptRegistry;
  runId: string;
  sessionId: string;
  cwd: string;
  project: Project | null;
  signal: AbortSignal;
  log: Logger;
  sudoPassword: () => string;
  runSubagent?: ToolRunCtx['runSubagent'];
  /** 文件改动的比对与撤回（影子 git）；没传就是不可用（工具会如实说明） */
  changes?: ToolRunCtx['changes'];
};

export type ExecutionResult = {
  tool: Tool | null;
  result: ToolResult;
  /** 工具所属插件（记账、串行判定、界面归类都用它） */
  pluginId: string;
  ms: number;
};

export function createToolExecutor(deps: ExecutorDeps) {
  const used = new Map<string, number>();

  function budgetOf(pluginId: string): number {
    const maxCalls = Number(deps.plugins.paramsOf(pluginId)['max_calls'] ?? 0);
    const max = Number.isFinite(maxCalls) && maxCalls > 0 ? maxCalls : Number.POSITIVE_INFINITY;
    return max - (used.get(pluginId) ?? 0);
  }

  function spend(pluginId: string, n = 1): void {
    used.set(pluginId, (used.get(pluginId) ?? 0) + n);
  }

  async function run(call: ToolCall, seq: number): Promise<ExecutionResult> {
    const started = Date.now();
    const tool = deps.plugins.toolByName(call.name);
    if (!tool) {
      const known = deps.plugins.tools().map((t) => t.name);
      return {
        tool: null,
        pluginId: 'loop',
        ms: 0,
        result: {
          ok: false,
          text: `${deps.prompts.text('loop.unknown_tool', { name: call.name })}\n当前可用工具：${known.join(', ')}`,
        },
      };
    }
    const pluginId = tool.pluginId;
    const ctx: ToolRunCtx = {
      runId: deps.runId,
      sessionId: deps.sessionId,
      seq,
      cwd: deps.cwd,
      project: deps.project,
      signal: deps.signal,
      param: (key) => deps.plugins.paramsOf(pluginId)[key],
      remaining: (key) => budgetOf(key),
      spend: (key, n) => spend(key, n),
      prompt: (id, vars) => deps.prompts.text(id, vars),
      log: deps.log,
      sudoPassword: deps.sudoPassword,
      runSubagent: deps.runSubagent,
      ...(deps.changes ? { changes: deps.changes } : {}),
    };
    try {
      const result = await tool.run(call.args ?? {}, ctx);
      return { tool, pluginId, ms: Date.now() - started, result: normalize(result) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log.warn(`工具 ${call.name} 抛错`, { msg });
      return {
        tool,
        pluginId,
        ms: Date.now() - started,
        result: { ok: false, text: `工具 ${call.name} 执行失败：${msg}` },
      };
    }
  }

  function normalize(r: ToolResult): ToolResult {
    const text = typeof r?.text === 'string' ? r.text : String(r?.text ?? '');
    // 图片兜底：最多 4 张、单张 base64 ≤ 4MB（截图工具自己已经压过，这里是防手滑）
    const images = (r?.images ?? []).filter((i) => i?.data && i.data.length <= 4 * 1024 * 1024).slice(0, 4);
    return {
      ok: r?.ok !== false,
      text: text || '（无输出）',
      note: r?.note ?? firstLine(text),
      lines: r?.lines,
      files: r?.files,
      media: r?.media,
      ...(images.length ? { images } : {}),
      refreshPrompt: r?.refreshPrompt,
    };
  }

  /** 工具表（给模型看的 schema）：名字 + 生效描述 + 参数 schema */
  function toolDefs(): ToolDef[] {
    return deps.plugins.tools().map((t) => ({
      name: t.name,
      description: t.desc?.() ?? t.description,
      schema: t.schema,
    }));
  }

  /** 需要串行执行的工具（屏幕/浏览器这类独占外部资源的）；其余可并行 */
  function isExclusive(name: string): boolean {
    const plugin = deps.plugins.pluginOfTool(name);
    if (!plugin) return false;
    if (plugin.serialize) return true;
    return ['screen', 'browser', 'exec', 'fs', 'deliver'].includes(plugin.id);
  }

  return { run, toolDefs, isExclusive, budgetOf, spend };
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const one = line.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 80)}…` : one;
}

export type ToolExecutor = ReturnType<typeof createToolExecutor>;
