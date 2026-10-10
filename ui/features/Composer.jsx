/**
 * ui/features/Composer.jsx —— 底部输入区：Enter 发送 / Shift+Enter 换行；运行中可「插队」或「立即执行」。
 *
 * 运行中发送 = **先排队**（标准做法：Codex 的 Enter 入队、Claude Code 的打字排队）：
 *   · 排队条显示在**输入框上方**（可折叠），一条条列着还没执行的补充说明；
 *   · **不进消息区** —— 没执行的消息不该出现在对话里（执行时服务端发 msg 事件，那时才落进对话）；
 *   · 每条可以「立即执行」（打断当前模型调用、插到最前，等价 Codex instant_interrupt）
 *     或直接删除；这一轮跑完还没单独处理的，轮次边界自动交给模型（运行结束还有剩的会自动续一段）。
 *
 * **输入框必须是非受控的**：不传 value，值由我们自己写进 DOM。
 * 原因（旧项目用真实 Chrome + IME 复现过）：受控 textarea 每次输入后 React 都要把值回写 DOM，
 * Chromium 的输入法组合态经不起这次回写——组合被取消后预编辑变成"插到光标处"，
 * 于是拼音与汉字叠加（"ni" → "nni"、"nihao" → "nninihao"）。
 * placeholder 恒定不变：它随状态变化时 React 同样会提交一次 DOM 更新，风险一致
 *（所以运行中的提示写在下面那行小字里，不动 placeholder）。
 *
 * 发送时机：不在组合中（isComposing / keyCode 229 都要挡——部分输入法只给 229）。
 * 清空时机：POST 成功返回后，且**框里还是刚发出去的那段文字**时才清（往返期间用户可能又打了字）。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../state/store.js';
import { executeQueued, queueOf, removeQueued, send, stopRun } from '../state/session.js';
import { Badge, Btn, Icon } from './ui.jsx';

export default function Composer() {
  const st = useApp();
  const streaming = Boolean(st.activeId && st.runs[st.activeId]);
  const queued = queueOf(st.activeId);
  const [queueOpen, setQueueOpen] = useState(true);
  const taRef = useRef(null);

  // 自增高：上限 200px；只在挂载/会话切换时量一次（生成中的高频重渲不触发布局）
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [st.activeId]);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    ta.style.overflowY = ta.scrollHeight > 200 ? 'auto' : 'hidden';
  };

  const submit = async () => {
    const ta = taRef.current;
    if (!ta) return;
    const text = ta.value;
    if (!text.trim()) return;
    const ok = await send(text, 'steer');
    // 只在内容没变时清空：往返期间用户新打的字不能被抹掉
    if (ok && ta.value === text) {
      ta.value = '';
      grow();
      ta.focus();
    }
  };

  const onKeyDown = (e) => {
    // 组合期间的回车是"上屏候选词"，不是发送；不挡的话会吃掉候选词还把半截内容发出去
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    void submit();
  };

  return (
    <div className="shrink-0 border-t border-line bg-panel/70 pr-5 pt-2 pb-[max(0.6rem,env(safe-area-inset-bottom))] backdrop-blur">
      <div className="chat-col">
        {/* 排队条：还没执行的补充说明。可折叠；**不进消息区**（执行时才落进对话） */}
        {queued.length ? (
          <div className="mb-1.5 overflow-hidden rounded-xl border border-line bg-panel/70">
            <button type="button" onClick={() => setQueueOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left">
              <Icon name={queueOpen ? 'chevron-down' : 'chevron'} className="size-3.5 shrink-0 text-subtle" />
              <Icon name="queue" className="size-3.5 shrink-0 text-accent" />
              <span className="text-[11.5px] font-medium text-muted">排队 {queued.length} 条</span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-subtle">这一轮跑完自动执行 · 可单条「立即执行」或删除</span>
            </button>
            {queueOpen ? (
              <ul className="flex flex-col gap-1 border-t border-line px-2 py-1.5">
                {queued.map((it) => (
                  <li key={it.id} className="flex items-start gap-2 rounded-lg bg-raise/40 px-2 py-1">
                    <span className="min-w-0 flex-1 text-xs leading-relaxed whitespace-pre-wrap break-words">{it.text}</span>
                    {it.mode === 'urgent' ? <Badge tone="warn">已请求立即执行</Badge> : null}
                    <Btn size="sm" onClick={() => void executeQueued(it.id)} title="立即执行：打断当前模型调用，把这条插到最前">
                      <Icon name="zap" className="size-3" />
                      立即执行
                    </Btn>
                    <Btn size="sm" variant="ghost" onClick={() => void removeQueued(it.id)} title="从队列里删掉（还没执行，删了就当没说过）">
                      <Icon name="close" className="size-3" />
                    </Btn>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="rounded-2xl border border-line bg-card focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15">
          <textarea
            ref={taRef}
            rows={1}
            onInput={grow}
            onKeyDown={onKeyDown}
            placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
            className="thin-scroll block max-h-[200px] min-h-[2.6rem] w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[15px] leading-relaxed text-fg outline-none placeholder:text-subtle"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-subtle">
              {streaming
                ? '运行中：Enter 排队（这一轮跑完自动执行）· 队内可单条「立即执行」或删除'
                : st.currentProjectId
                  ? `新会话归属：${st.projects.find((p) => p.id === st.currentProjectId)?.name ?? st.currentProjectId}`
                  : ''}
            </span>
            {streaming ? (
              <Btn variant="danger" size="sm" onClick={() => void stopRun()} title="停止这段运行（已生成的内容会保留）">
                <Icon name="stop" className="size-3.5" />
                停止
              </Btn>
            ) : null}
            <Btn
              variant="primary"
              size="sm"
              onClick={() => void submit()}
              title={streaming ? '排队：这一轮跑完自动交给模型（Enter）' : '发送（Enter）'}
            >
              <Icon name={streaming ? 'queue' : 'send'} className="size-3.5" />
              {streaming ? '排队' : '发送'}
            </Btn>
          </div>
        </div>
        {st.sessions.length === 0 && !st.activeId ? (
          <p className="mt-1 text-center text-[10.5px] text-subtle">发送后会创建新会话；也可以先到「设置 → 模型与参数」配好服务商。</p>
        ) : null}
      </div>
    </div>
  );
}
