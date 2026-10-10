/**
 * src/providers/types.ts —— 模型协议层的唯一契约。
 *
 * 上层（agent/loop.ts）只认这里的类型：换协议、换网关都不动循环。
 */

export type ProviderType = 'openai' | 'anthropic';

export type ProviderConfig = {
  id: string;
  name: string;
  type: ProviderType;
  /** 形如 https://api.example.com/v1（openai）或 https://api.anthropic.com（anthropic） */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 上下文窗口（token），用于估算占用；0/缺省 = 不提示 */
  ctxLimit?: number;
  /** 直接并进请求体的额外字段（如 temperature、extra_body） */
  extraBody?: Record<string, unknown>;
  /** 额外请求头 */
  headers?: Record<string, string>;
  /** 段落级稳定 ID：opencode 网关需要 x-opencode-session，缺了直接 400 */
  sessionId?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 参数 JSON 解析失败时的原文（截断保护用） */
  raw?: string;
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant：本轮发起的工具调用 */
  toolCalls?: ToolCall[];
  /** tool：对应哪次调用 */
  toolCallId?: string;
  /** assistant：思考全文；Anthropic 扩展思考回传必须带签名 */
  thinking?: string;
  thinkingSig?: string;
  /** 伴随这条消息的图片（工具截图、用户贴图）；按协议渲染成 image_url / image 块 */
  images?: Array<{ mime: string; data: string }>;
};

export type ToolDef = {
  name: string;
  description: string;
  /** JSON Schema（object） */
  schema: Record<string, unknown>;
};

export type StreamEvent =
  | { kind: 'thinking'; text: string }
  /** Anthropic 扩展思考的签名增量：必须累积起来，下一轮回传 {thinking + signature} 才合法 */
  | { kind: 'thinking_sig'; sig: string }
  | { kind: 'content'; text: string }
  | { kind: 'tool_calls'; calls: ToolCall[] }
  | { kind: 'usage'; input: number; output: number }
  /**
   * 收尾标记。`clean: false` = **上游没给收尾标记就结束了**（既没有 finish_reason 也没有 [DONE]）——
   * 这跟"正常回答完了"必须区分开：半截正文不能被当成最终回答（旧项目"半句停住"的教训）。
   */
  | { kind: 'stop'; reason: string; clean?: boolean }
  | {
      kind: 'error';
      message: string;
      /** 上游自己的判断（5xx/429/408/网络错 = 可重试）。上层优先用它，别拿文案正则猜 */
      retryable?: boolean;
      /** 上游说"多久之后再来"（Retry-After / ratelimit 头），毫秒 */
      retryAfterMs?: number;
    };

export type ChatOptions = {
  tools?: ToolDef[];
  /** 采样参数：temperature / max_tokens / thinking 预算等，按协议翻译 */
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  /** 段落级稳定 ID（同一会话同一值） */
  sessionId?: string;
};

export type ChatFn = (
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts?: ChatOptions,
) => AsyncGenerator<StreamEvent>;

export type ListModelsFn = (cfg: ProviderConfig, signal?: AbortSignal) => Promise<string[]>;
