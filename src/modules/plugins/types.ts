/**
 * src/modules/plugins/types.ts —— 插件的唯一契约。
 *
 * 插件 = 提示词（告诉模型"能做什么、怎么做"） + 可执行命令（工具，真正去做）。
 * 三个来源共用这套类型：内置插件（代码）、自定义插件（界面里写命令模板）、外部资源（MCP/HTTP 工具）。
 */
import type { Project } from '../../store/projects.ts';
import type { Logger } from '../../util/log.ts';

export type ParamDef = {
  key: string;
  name: string;
  type: 'number' | 'string' | 'boolean';
  def: unknown;
  desc?: string;
};

/** 模型能"看见"的图片（base64，不含 data: 前缀）。MCP 的 image 内容块、截图工具都用它 */
export type ToolImage = { mime: string; data: string };

/**
 * 工具结果的**标准错误码**（界面按它分类、审计按它聚合，不靠中文文案正则猜）。
 *
 * 命名对齐 dsh 的做法，逐个都是本工程真实出现过的场景：
 *  - `ABORTED_BEFORE_DISPATCH`：用户在工具**还没派发**时就掐断了（结果=没执行）。
 *  - `TOOL_OUTCOME_UNKNOWN`：已派发但没等到结果（被掐断/超时/进程没了）——**不能**当成"没执行"。
 *  - `BUDGET_EXHAUSTED`：插件额度用完（用户参数决定的预算）。
 *  - `INVALID_ARGS`：参数不合法/缺必填（工具自己判的）。
 *  - `NOT_FOUND`：目标不存在（文件/会话/记录）。
 *  - `EXEC_FAILED`：执行了但失败（非零退出、抛异常）。
 *  - `UPSTREAM`：上游/依赖服务错误。
 *  - `UNKNOWN_TOOL`：模型调了一个不存在或未启用的工具。
 *  - `LOOP_GUARD`：循环守卫拦下的（重复空转、连续截断…）。
 */
export type ToolErrorCode =
  | 'ABORTED_BEFORE_DISPATCH'
  | 'TOOL_OUTCOME_UNKNOWN'
  | 'BUDGET_EXHAUSTED'
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'EXEC_FAILED'
  | 'UPSTREAM'
  | 'UNKNOWN_TOOL'
  | 'LOOP_GUARD';

/**
 * 要给**用户看**的媒体（与 ToolImage 方向相反：ToolImage 是给模型看的，ToolMedia 是给人看的）。
 * 两种来源：`url`（外部链接，前端直接加载）或 `download`（待下载目录里的文件名，
 * 前端用 fileUrl() 补上登录令牌再渲染 —— 令牌只在浏览器里，服务端拼不出可用的 URL）。
 */
export type ToolMedia = {
  kind: 'image' | 'video' | 'audio';
  url?: string;
  download?: string;
  caption?: string;
};

export type ToolResult = {
  ok: boolean;
  /** 回灌给模型的内容（可以是长文；落盘时全文进 run journal） */
  text: string;
  /**
   * 结构化错误码：给界面**分类**用（不再靠中文文案正则猜）。
   * 借鉴 dsh 对"未派发/未应答调用"的统一补码。只有 ok=false 才有意义。
   */
  errorCode?: ToolErrorCode;
  /** 折叠时显示的一行摘要（默认从 text 首行截断） */
  note?: string;
  /** 文件改动行数（界面显示 +N/−M） */
  lines?: { added: number; removed: number };
  files?: string[];
  /** 回灌给模型的图片（模型有视觉能力时才有效；大小由各工具自己控制） */
  images?: ToolImage[];
  /** 给用户看的媒体（前端渲染成图片/播放器） */
  media?: ToolMedia[];
  /** 提示词需要重算（记忆/技能/插件被改动后） */
  refreshPrompt?: boolean;
  /**
   * 超大结果被落盘（spill）时的记录：完整正文在 `path`，回灌给模型的是头尾预览。
   * 界面据此显示"全文已落盘，点开看/复制路径"，模型也能 read_file 取细节。
   * 未落盘就没有这个字段（结果本来就短，直接内联）。
   */
  spill?: { path: string; chars: number };
};

export type ToolRunCtx = {
  runId: string;
  sessionId: string;
  /** 本次调用的序号（同一 run 内递增），详情按它取 */
  seq: number;
  cwd: string;
  project: Project | null;
  signal: AbortSignal;
  /** 读插件参数（用户设定值，服务端不做硬上限） */
  param: (key: string) => unknown;
  /** 预算：取剩余次数 / 扣减（按插件 id 记账，一次运行内共享） */
  remaining: (key: string) => number;
  spend: (key: string, n?: number) => void;
  /** 提示词注册中心取文本 */
  prompt: (id: string, vars?: Record<string, string>) => string;
  log: Logger;
  /** 用户登录后保存的本机密码（执行 sudo 用）；没登录就是空 */
  sudoPassword: () => string;
  /** 子智能体：由运行宿主注入（避免模块循环依赖） */
  runSubagent?: (task: string, opts: { tools?: string[]; readOnly?: boolean; maxRounds?: number }) => Promise<{ ok: boolean; text: string; runId: string; id?: string }>;
  /**
   * 子智能体的**控制面**（由运行宿主注入）：列表 / 续谈 / 中断。
   * 让子智能体不是"一次性把结论带回来就消失"，而是可以被父体继续追问、被中断、被列举
   * （对照 dsh 的 subagent 家族：continuable / message / interrupt / list）。
   */
  subagents?: {
    list: () => Array<{ id: string; task: string; status: string; parentRunId?: string; createdAt: number; runs: number; finalText?: string }>;
    send: (id: string, text: string) => Promise<{ ok: boolean; text: string; runId: string; id: string }>;
    stop: (id: string) => boolean;
  };
  /**
   * 文件改动的"比对与撤回"（影子 git 仓库，见 store/checkpoints.ts）。
   * 写文件的工具在**动手前**调 `snapshot` 记一笔；`changes` 插件用它列改动/看 diff/撤回。
   * 可选：没有会话上下文（比如测试）时就是 undefined，工具要能照常工作。
   */
  changes?: {
    snapshot: (label: string, files: string[]) => Promise<{ id: string; label: string } | null>;
    list: () => Promise<Array<{ id: string; ts: number; label: string; files: string[]; added?: number; removed?: number }>>;
    diff: (id?: string) => Promise<{
      text: string;
      stat: { files: number; added: number; removed: number; list: Array<{ path: string; added: number; removed: number }> };
    }>;
    /** 某个检查点之后改了什么（与下一个检查点比；最新的那条与当前工作树比） */
    show: (id: string, file?: string) => Promise<{
      text: string;
      stat: { files: number; added: number; removed: number; list: Array<{ path: string; added: number; removed: number }> };
    }>;
    restore: (id: string) => Promise<{ ok: boolean; detail: string; files: string[]; removed: string[] }>;
  };
};

export type Tool = {
  name: string;
  pluginId: string;
  /** 默认描述：注册进提示词中心（tool.<name>.desc），用户可在界面上改 */
  description: string;
  /** 生效描述（由插件登记表注入：优先取提示词中心的覆盖值） */
  desc?: () => string;
  schema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolRunCtx) => Promise<ToolResult>;
};

export type PluginDef = {
  id: string;
  name: string;
  desc: string;
  builtin: boolean;
  /** 由外部资源注册进来的（界面上归「外部资源」页，不进「插件」页） */
  external?: boolean;
  /** 外部资源自己管参数：登记表读参数时问它（参数存在资源自己的文件里） */
  readParams?: () => Record<string, unknown>;
  /** 用法说明在提示词中心的 id（plugin.<id>.usage） */
  promptId: string;
  prompt: string;
  params: ParamDef[];
  tools: Tool[];
  /** 命中这些工具名时串行执行（互斥资源，比如屏幕/浏览器） */
  serialize?: boolean;
};
