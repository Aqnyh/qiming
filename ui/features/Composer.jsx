/**
 * ui/features/Composer.jsx —— 底部输入区：Enter 发送 / Shift+Enter 换行；运行中按队列语义。
 *
 * 运行中再发一句话的**默认行为 = 排队**（`queue`）：先收进队列，**当前这一段运行跑完后
 * 自动接着执行**。这是"运行中再发一句"最符合直觉的语义 —— 不做当前轮次内的插队。
 * 想要**当前轮次内**就反馈，只有一个入口：队列条上那一条的「立即执行」（`urgent`，
 * 掐掉当前模型调用/正在跑的工具，立刻转向）。
 *
 * 另外保留一个显式选项：**Alt+Enter = 插话（steer）**，在当前轮次的**安全点**
 * （每次工具返回后 / 每次模型调用后）注入，不打断。默认不走它。
 * 三种语义由服务端的系统参数 `queueDefault` 决定"不指定时用哪个"（设置 → 系统）。
 *
 * 队列条在**输入框上方**（可折叠）；排队中的消息**不进消息区**（执行时服务端发 msg 事件）。
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

const MODE_HINT = {
  steer: { label: '插话', tip: '插话：不打断，当前轮次的下个安全点（工具跑完/模型调用后）交给模型' },
  queue: { label: '排队', tip: '排队：当前这一轮跑完，自动接着执行（默认行为）' },
  urgent: { label: '打断', tip: '已请求立即执行：掐掉当前模型调用或工具，立刻转向' },
};

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

  /** mode 传 undefined = 用服务端的系统默认（设置 → 系统 → queueDefault，默认 queue） */
  const submit = async (mode) => {
    const ta = taRef.current;
    if (!ta) return;
    const text = ta.value;
    if (!text.trim()) return;
    const ok = await send(text, mode);
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
    // Enter = 默认（排队，这一段跑完接着执行）；Alt+Enter = 插话（当前轮次安全点注入）
    void submit(e.altKey ? 'steer' : undefined);
  };

  return (
    <div className="shrink-0 border-t border-line bg-panel/70 pr-5 pt-2 pb-[max(0.6rem,env(safe-area-inset-bottom))] backdrop-blur max-sm:pr-0">
      <div className="chat-col">
        {/* 队列条：还没执行的补充说明。可折叠；**不进消息区**（执行时才落进对话） */}
        {queued.length ? (
          <div className="mb-1.5 overflow-hidden rounded-xl border border-line bg-panel/70">
            <button type="button" onClick={() => setQueueOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left">
              <Icon name={queueOpen ? 'chevron-down' : 'chevron'} className="size-3.5 shrink-0 text-subtle" />
              <Icon name="queue" className="size-3.5 shrink-0 text-accent" />
              <span className="text-[11.5px] font-medium text-muted">队列 {queued.length} 条</span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-subtle">默认：这一段跑完自动接着执行 · 想当前轮次内反馈点「立即执行」</span>
            </button>
            {queueOpen ? (
              <ul className="flex flex-col gap-1 border-t border-line px-2 py-1.5">
                {queued.map((it) => {
                  const hint = MODE_HINT[it.mode] ?? MODE_HINT.steer;
                  return (
                    <li key={it.id} className="flex items-start gap-2 rounded-lg bg-raise/40 px-2 py-1">
                      <span className="min-w-0 flex-1 text-xs leading-relaxed break-words whitespace-pre-wrap">{it.text}</span>
                      <Badge tone={it.mode === 'urgent' ? 'warn' : it.mode === 'queue' ? 'default' : 'accent'}>{hint.label}</Badge>
                      <Btn size="sm" onClick={() => void executeQueued(it.id)} title="立即执行：掐掉当前模型调用或正在跑的工具，立刻转向">
                        <Icon name="zap" className="size-3" />
                        立即执行
                      </Btn>
                      <Btn size="sm" variant="ghost" onClick={() => void removeQueued(it.id)} title="从队列里删掉（还没执行，删了就当没说过）">
                        <Icon name="close" className="size-3" />
                      </Btn>
                    </li>
                  );
                })}
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
            className="thin-scroll block max-h-[200px] min-h-[2.6rem] w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[15px] leading-relaxed text-fg outline-none placeholder:text-subtle max-md:min-h-[3rem]"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-subtle max-md:hidden">
              {streaming
                ? '运行中：Enter 排队（这一段跑完自动执行）· Alt+Enter 插话（当前轮次内）· 队内可「立即执行」打断'
                : st.currentProjectId
                  ? `新会话归属：${st.projects.find((p) => p.id === st.currentProjectId)?.name ?? st.currentProjectId}`
                  : ''}
            </span>
            {streaming ? (
              <Btn variant="danger" size="sm" className="max-sm:ml-auto max-md:h-10 max-md:px-3" onClick={() => void stopRun()} title="停止这段运行（已生成的内容会保留）">
                <Icon name="stop" className="size-3.5" />
                停止
              </Btn>
            ) : null}
            <Btn
              variant="primary"
              size="sm"
              className="max-md:h-10 max-md:px-4"
              onClick={() => void submit(undefined)}
              title={streaming ? '排队：这一段跑完自动接着执行（Enter）；想当前轮次内插话按 Alt+Enter' : '发送（Enter）'}
            >
              <Icon name={streaming ? 'queue' : 'send'} className="size-3.5" />
              {streaming ? '排队' : '发送'}
            </Btn>
          </div>
        </div>
        {st.sessions.length === 0 && !st.activeId ? (
          <p className="mt-1 text-center text-[10.5px] text-subtle">发送后会创建新会话；也可以先到「设置 → 模型」配好服务商。</p>
        ) : null}
      </div>
    </div>
  );
}
