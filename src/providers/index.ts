/**
 * src/providers/index.ts —— 协议层入口：按 cfg.type 分派 + 协议层公共约定。
 *
 * 上层（agent/loop.ts）只 import 这个文件：chat / listModels / errorText。
 *
 * 分派：openai → ./openai.ts（含一切「说 OpenAI 话」的实现），anthropic → ./anthropic.ts。
 *
 * 公共约定（都是旧项目 agent/src/core/protocol/transport.js 的移植，只取意图不搬传输层）：
 *   · errorText(status, body)   —— 非 2xx 的友好文案：401/403/404/408/413/429/5xx 各一句人话
 *     + 响应体前 500 字（旧 errorText + modelError 的「只说一句 HTTP 401 用户无从修起」教训）；
 *   · resolveTools(opts)        —— 工具清单既可能在 opts.tools（新契约口径），也可能被塞进
 *     params.tools（旧口径），两处都认（漏掉的后果：模型收不到工具清单，把调用写成正文）；
 *   · applyExtraBody(...)       —— cfg.extraBody 合并进请求体，核心字段不许被覆盖；
 *   · sessionHeaderFor/sessionValue —— 「会话标识头」规则（旧 transport.js + lib/agent/upstream.js）：
 *     按 Base URL 域名认网关，只有已知需要它的网关（opencode.ai）才注入 x-opencode-session，
 *     且不覆盖用户自定义头；值按形状校验（不合规就不带，由上游回落）。
 *
 * 移植时改了什么：旧 transport.js 的「同源代转 + 密钥服务端注入」不移植——新项目各家适配器
 * 直接用全局 fetch 连上游，密钥在 cfg 里；因此这层只留「两家共用、不能有第二份实现」的约定。
 */
import type {
  ChatFn, ChatMessage, ChatOptions, ListModelsFn, ProviderConfig, StreamEvent, ToolDef,
} from './types.ts';
import { chat as openaiChat, listModels as openaiListModels } from './openai.ts';
import { chat as anthropicChat, listModels as anthropicListModels } from './anthropic.ts';

export type {
  ProviderConfig, ChatMessage, ChatOptions, ChatFn, ListModelsFn, StreamEvent, ToolCall, ToolDef,
} from './types.ts';

/** 出站 UA：网关按它识别「这是哪个客户端」——opencode Go 这类网关对通用 HTTP 库名字不友好
 *  （旧项目用 wenming-agent/2.0，同为「编码智能体」口径）。 */
export const CLIENT_UA = 'qiming-agent/0.1';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ============================ 错误文案 ============================ */

/** 各状态码一句人话（认不出来就不编） */
function friendlyReason(status: number): string {
  if (status === 401) return '密钥无效或没带上（检查 API Key）';
  if (status === 403) return '没有权限：密钥被拒、账号或模型未开通';
  if (status === 404) return '接口地址或模型名不存在（检查 Base URL 与 model）';
  if (status === 408) return '上游等待超时';
  if (status === 413) return '请求体过大（上下文超限）';
  if (status === 429) return '请求过于频繁或额度用尽（稍后重试）';
  if (status >= 500) return '模型服务端错误（可稍后重试）';
  return '';
}

/** 从错误正文里抽一句可读的（认 error.message / error.type / message / detail；否则压缩原文） */
function pickMessage(body: string): string {
  const txt = String(body ?? '').trim();
  if (!txt) return '';
  try {
    const j: unknown = JSON.parse(txt);
    if (isObj(j)) {
      const err = j.error;
      const m = (isObj(err) ? (err.message ?? err.type) : err) ?? j.message ?? j.detail;
      if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 500);
    }
  } catch {
    /* 不是 JSON：当纯文本用 */
  }
  return txt.replace(/\s+/g, ' ').slice(0, 500);
}

/**
 * 上游非 2xx 的友好文案：`HTTP 401：密钥无效或没带上（检查 API Key）｜invalid api key`。
 * 只给「HTTP 401」用户既不知道是密钥错了、额度用完了还是模型名写错了，也就无从修起；
 * 但正文也可能很长，截前 500 字（旧项目 errorText 的口径）。
 */
export function errorText(status: number, body: string): string {
  const head = 'HTTP ' + status;
  const why = friendlyReason(status);
  const detail = pickMessage(body);
  return head + (why ? '：' + why : '') + (detail ? '｜' + detail : '');
}

/** 哪些 HTTP 状态值得重试：5xx（服务端抽风）/ 429（限流）/ 408（上游超时）。
 *  两家适配器共用一份，避免「同样的 503 在 openai 能重试、在 anthropic 不能」。 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * 上游说"多久之后再来" → 毫秒。认两种写法：秒数（`Retry-After: 30`）与 HTTP 日期。
 * 也看常见的 ratelimit 重置头。**封顶 120 秒**：上游不该把我们按在一小时的等待里。
 */
export function retryAfterMsOf(r: Response, now = Date.now()): number {
  const raw = String(r.headers.get('retry-after') ?? r.headers.get('x-ratelimit-reset-requests') ?? '').trim();
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 120_000);
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, Math.min(when - now, 120_000));
  return 0;
}

/** 失败响应读正文 → errorText（读到多少算多少；读不动就只报状态码） */
export async function upstreamErrorText(r: Response): Promise<string> {
  let txt = '';
  try {
    txt = String(await r.text()).slice(0, 4000);
  } catch {
    /* 读不动就算了 */
  }
  return errorText(r.status, txt);
}

/** fetch / 流中途抛错的统一人话（网络错可重试；用户点「停止」不算错误） */
export function netError(e: unknown, cfg: ProviderConfig, signal?: AbortSignal): { message: string; retryable: boolean } {
  const aborted = signal?.aborted === true || (e instanceof Error && e.name === 'AbortError');
  if (aborted) return { message: '请求已取消', retryable: false };
  const reason = e instanceof Error ? e.message : String(e);
  let where = cfg.baseUrl || '(未设置地址)';
  try {
    where = new URL(cfg.baseUrl).origin;
  } catch {
    /* 地址不合法：就报原文 */
  }
  return { message: `无法连接 ${where}：${reason}（网络错误）`, retryable: true };
}

/* ============================ 工具清单与请求体 ============================ */

/** 工具定义的口径兼容（旧 transport.js 的 resolveTools）：opts.tools 优先，params.tools 兜底；
 *  顺手把字段归一成契约的 ToolDef（缺 description/schema 也给保底，宁可多发的工具定义字段
 *  只占几行，也好过模型收不到工具清单）。 */
export function resolveTools(opts?: ChatOptions): ToolDef[] {
  const raw: unknown = opts?.tools ?? (isObj(opts?.params) ? opts.params.tools : undefined);
  if (!Array.isArray(raw)) return [];
  const out: ToolDef[] = [];
  for (const t of raw) {
    if (!isObj(t) || typeof t.name !== 'string' || !t.name) continue;
    out.push({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      schema: isObj(t.schema) ? t.schema : { type: 'object', properties: {} },
    });
  }
  return out;
}

/** 请求体里不许被 extraBody 覆盖的字段（旧 lib/agent/upstream.js 的 applyExtraBody 口径，
 *  另加 stream_options：usage 事件靠它，被覆盖会静默丢用量） */
const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'system']);

/** 把 cfg.extraBody（已是对象；旧项目是服务端解析的 JSON 文本）并进请求体；不允许覆盖核心字段 */
export function applyExtraBody(body: Record<string, unknown>, extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return body;
  for (const [k, v] of Object.entries(extra)) {
    // echo_thinking 是本项目的控制开关（见 openai.ts），不是上游字段，不能发出去
    if (PROTECTED_BODY_KEYS.has(k) || k === '__proto__' || k === 'echo_thinking') continue;
    body[k] = v;
  }
  return body;
}

/** Base URL + 协议路径（保留 Base URL 自带的查询串——Azure 的 ?api-version=… 就写在地址里） */
export function joinUrl(baseUrl: string, path: string): string {
  const u = new URL(String(baseUrl || '').trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 的 Base URL');
  const prefix = u.pathname.replace(/\/+$/, '');
  return u.protocol + '//' + u.host + prefix + path + (u.search || '');
}

/* ============================ 会话标识头 ============================ */

/** 「会话标识头」的自动判定（按 Base URL 域名认网关）。
 *  有些网关要求客户端为**每段对话**带一个稳定 id，否则直接 400——opencode Go 就是；
 *  命中下表才带（自建网关没有配置入口，规则从旧代码原样搬）。 */
const SESSION_HEADER_BY_HOST: Array<{ suffix: string; header: string }> = [
  { suffix: 'opencode.ai', header: 'x-opencode-session' },
];

export function sessionHeaderFor(baseUrl: string): string {
  let host = '';
  try {
    host = new URL(String(baseUrl || '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
  for (const it of SESSION_HEADER_BY_HOST) {
    if (host === it.suffix || host.endsWith('.' + it.suffix)) return it.header;
  }
  return '';
}

/** 会话标识的**值**：形状合法才带（与旧 sessionIdOf 同一正则）；空值同样被判 MissingSessionID，
 *  所以拿不到合法 id 就干脆不带（旧实现的「回落成账号稳定 id」是服务端能力，客户端没有）。 */
const SESSION_VALUE_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function sessionValue(sessionId: string | undefined): string {
  const raw = String(sessionId ?? '').trim();
  return SESSION_VALUE_RE.test(raw) ? raw : '';
}

/** 把用户自定义头与会话标识头并进请求头（两家适配器共用一份；会话标识头不覆盖用户手填的同名头） */
export function mergeRequestHeaders(
  headers: Record<string, string>,
  cfg: ProviderConfig,
  opts?: ChatOptions,
): Record<string, string> {
  const custom = new Set<string>();
  if (cfg.headers && typeof cfg.headers === 'object') {
    for (const [k, v] of Object.entries(cfg.headers)) {
      const lk = String(k).toLowerCase();
      if (lk === 'authorization' || lk === 'x-api-key' || lk === 'host' || lk === 'content-length') continue;
      if (/^[a-z0-9-]{1,64}$/.test(lk) && typeof v === 'string') {
        headers[lk] = v.slice(0, 1000);
        custom.add(lk);
      }
    }
  }
  const sh = sessionHeaderFor(cfg.baseUrl);
  const sv = sessionValue(opts?.sessionId ?? cfg.sessionId);
  if (sh && sv && !custom.has(sh)) headers[sh] = sv;
  return headers;
}

/* ============================ 分派 ============================ */

/** 按 cfg.type 分派（未知类型按 openai 兼容处理——存量配置里的历史类型都升级成了 openai） */
export function chat(cfg: ProviderConfig, messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<StreamEvent> {
  return cfg.type === 'anthropic' ? anthropicChat(cfg, messages, opts) : openaiChat(cfg, messages, opts);
}

export function listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  return cfg.type === 'anthropic' ? anthropicListModels(cfg, signal) : openaiListModels(cfg, signal);
}
