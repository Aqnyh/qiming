/**
 * ui/state/api.js —— 所有 HTTP 请求的统一出口。
 *
 * 三条纪律：
 *  1. 令牌只存 localStorage，每个请求带 `x-qiming-token`（服务端唯一认这个头）；
 *  2. **任何**请求 401 都由这里统一处理（清令牌 → 回登录页），调用方不用各写一遍；
 *  3. `<img>/<video>/EventSource` 这类浏览器自己发起的请求带不了自定义头，
 *     统一走 `fileUrl()` / `eventsUrl()` 把令牌放进 query（服务端需支持 ?token=，见 README/回复说明）。
 */
const TOKEN_KEY = 'qiming.token';

export function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能不可写：不致命，退回登录页重登即可 */
  }
}

let onUnauthorized = null;

/** main.jsx 在启动时注册：401 → 回登录页（只此一处） */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * 发请求。`path` 以 /api/ 开头；body 传对象则自动 JSON 编码。
 * 出错时抛 ApiError（message 就是服务端给的人话），调用方 catch 后展示。
 */
export async function api(path, opts = {}) {
  const { method = 'GET', body, signal } = opts;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'x-qiming-token': readToken(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(`连不上服务：${err?.message ?? err}`, 0);
  }
  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: raw.slice(0, 400) };
    }
  }
  if (res.status === 401) {
    try {
      onUnauthorized?.();
    } catch {
      /* 处理器本身出错不影响抛错 */
    }
    throw new ApiError(data?.error || '未登录：请先用本机账号登录。', 401);
  }
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status);
  return data;
}

/** 待下载文件的地址（内联预览/下载都走这里；令牌进 query 才能给 img/video 用） */
export function fileUrl(name, inline = false) {
  const q = new URLSearchParams({ name: String(name ?? '') });
  if (inline) q.set('inline', '1');
  const token = readToken();
  if (token) q.set('token', token);
  return `/api/downloads/file?${q.toString()}`;
}

/** SSE 地址：EventSource 不能带自定义头，令牌只能进 query */
export function eventsUrl() {
  const token = readToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `/api/events${q}`;
}
