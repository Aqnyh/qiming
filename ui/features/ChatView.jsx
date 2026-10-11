/**
 * ui/features/ChatView.jsx —— 中间消息区（+ 底部输入框 + 右侧待办抽屉）。
 *
 * 布局与滚动（需求 2/7）：
 *   [侧栏] 20px [消息区（自己滚）/ 输入框（同一列）] 20px [待办抽屉（自己滚）]
 *   · 消息区与输入框在**同一列**里 → 宽度天然同步（各写一份就会错开十几像素）；
 *   · 三块各自 `min-h-0 + overflow-y-auto`，滚消息不会带动会话区/待办（这是之前的 bug：
 *     ChatView 根节点少了 min-h-0，整列被内容撑高 → 变成整个文档在滚）；
 *   · 抽屉是真实的一列（不是浮层），所以它有自己的滚动条，也不会盖住消息。
 *
 * **手机（<sm）没有右列**（2026-10-10 手机适配）：390px 宽再扣掉 256px 的右列就只剩半屏，
 * 所以待办/压缩/子智能体/文件改动只在宽屏占位；手机上的过程信息由消息内的折叠组承担。
 * 同时手机收起左右内边距（两边各 20px 的空白在手机上比一行字还宽）。
 * 注意「<sm 不占位」要靠 `max-sm:hidden` 这类显式的 display 工具类，不能写
 * `hidden ... sm:flex`：同层工具类里 w-64 会把前面的 `hidden` 顶掉（Tailwind v4 按源码顺序生效）。
 *
 * 数据来源：
 *  1. `state.msgs`：服务端整条会话（打开会话/运行收尾时对齐）；
 *  2. `state.streams[activeId]`：正在那段运行的**流式缓冲**（只含正文增量、思考预览、
 *     调用摘要、灰字提示——全文都不在这里），在消息列表末尾画成一条临时助手消息。
 *
 * **插话不进消息区**：用户在运行中补的话（排队/立即执行）由循环注入的浅文字提示呈现
 * （见 Message.jsx 的 notices）—— 那是它在界面上的唯一呈现，避免同一句话显示两遍。
 * 所以这里直接过滤掉 `msg.steer`，不渲染成气泡。
 */
import { useEffect, useRef } from 'react';
import { useApp } from '../state/store.js';
import Message from './Message.jsx';
import Composer from './Composer.jsx';
import TodoPanel from './TodoPanel.jsx';
import ChangesPanel from './ChangesPanel.jsx';
import CompactPanel from './CompactPanel.jsx';
import SubagentPanel from './SubagentPanel.jsx';
import { visibleMessages } from '../lib/message-parts.js';
import { Icon } from './ui.jsx';

/** 把流式缓冲拼成一条"像消息"的对象，交给 Message 渲染 */
function streamMessage(stream) {
  if (!stream) return null;
  return {
    id: stream.msgId,
    role: 'assistant',
    content: stream.content,
    ts: stream.startedAt,
    runId: stream.runId,
    calls: stream.calls,
    stats: stream.stats,
    thinkingChars: stream.thinkingChars,
    thinkingTail: stream.thinkingTail,
    notices: stream.notices,
    turn: stream.turn,
    step: stream.step,
  };
}

export default function ChatView() {
  const st = useApp();
  const scrollerRef = useRef(null);
  const stickRef = useRef(true); // 用户是否贴着底部看（贴着才自动滚，翻历史时不打扰）
  const stream = st.activeId ? st.streams[st.activeId] : null;
  const streaming = Boolean(stream && !stream.ended);
  const live = streamMessage(stream);
  // 插话不渲成气泡（由浅文字提示呈现）；这里只留真正的对话消息
  const normal = visibleMessages(st.msgs);
  const loading = Boolean(st.activeId && st.msgsFor !== st.activeId);
  const lastLen = live?.content?.length ?? 0;

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // 内容增长/新消息时滚到底（只在用户本来就在底部时）
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [st.msgs.length, lastLen, st.activeId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* 左列：消息区（自己滚）+ 输入框 —— 同一列所以同宽 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col pl-5 max-sm:pl-0">
        <div ref={scrollerRef} onScroll={onScroll} data-region="messages" className="thin-scroll min-h-0 flex-1 overflow-y-auto pr-5 max-sm:pr-0">
          {/* chat-col = 与输入框共用的同一份宽度（见 styles.css 的 --chat-max） */}
          <div className="chat-col py-2">
            {loading ? <p className="py-10 text-center text-xs text-subtle">正在加载会话…</p> : null}
            {!loading && !normal.length && !live ? (
              <div className="py-16 text-center">
                <span className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-accent/10 text-accent">
                  <Icon name="brain" className="size-6" />
                </span>
                <p className="text-sm text-muted">说点什么，启明会直接在这台机器上动手。</p>
                <p className="mt-1 text-[11px] text-subtle">工具调用与思考都收在折叠行里，点开才从服务端取全文。</p>
              </div>
            ) : null}
            {normal.map((m) => (
              <Message key={m.id} msg={m} />
            ))}
            {live ? <Message key={`live-${live.id}`} msg={live} streaming={streaming} /> : null}
          </div>
        </div>
        <Composer />
      </div>

      {/* 右列：待办 + 文件改动（各自滚），与消息区隔 20px。手机整列不占位（见文首说明）。
          用 div 而不是 aside：待办本身就是 <aside>，再套一层 aside 会让
          "第一个 aside = 侧栏"这类既有约定变得含糊（ui-check 就是按选择器量间距的）。 */}
      <div className="ml-5 flex w-64 shrink-0 flex-col py-2 max-sm:hidden" aria-label="右列">
        <TodoPanel />
        <CompactPanel />
        <SubagentPanel />
        <ChangesPanel />
      </div>
    </div>
  );
}
