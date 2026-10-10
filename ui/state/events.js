/**
 * ui/state/events.js —— SSE 事件流的接入。
 *
 * 一条 EventSource 收全部会话的运行事件（事件本身带 runId/sessionId，前端自己分流；
 * 见 session.js 的 applyEvent）。断开由浏览器自动重连，这里只把连接状态报给顶栏。
 *
 * 注意：EventSource 不能带自定义请求头，令牌只能走 query（`/api/events?token=...`），
 * 需要服务端在 /api/events 上接受 token 参数（用户在改）。
 */
import { eventsUrl } from './api.js';
import { patch } from './store.js';
import { applyEvent } from './session.js';

let es = null;

export function connectEvents() {
  if (es) return;
  if (typeof EventSource === 'undefined') {
    patch({ sse: 'error' });
    return;
  }
  try {
    es = new EventSource(eventsUrl());
  } catch {
    patch({ sse: 'error' });
    return;
  }
  es.onopen = () => patch({ sse: 'open' });
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return; // 心跳注释与畸形数据都跳过（sseStart 发的是 `: ping`，浏览器不会当 message 派发）
    }
    try {
      applyEvent(ev);
    } catch (err) {
      console.warn('[qiming] 事件处理失败', err, ev);
    }
  };
  // 不主动关闭：浏览器会按 EventSource 规则自动重连；这里只更新状态点
  es.onerror = () => patch({ sse: 'error' });
}

export function disconnectEvents() {
  try {
    es?.close();
  } catch {
    /* 已经断开 */
  }
  es = null;
  patch({ sse: 'off' });
}
