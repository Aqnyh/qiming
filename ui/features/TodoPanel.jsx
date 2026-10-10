/**
 * ui/features/TodoPanel.jsx —— 右侧「待办」抽屉（模型用 todo_write 维护的清单）。
 *
 * **常驻右侧、始终留位**（需求：右侧要给待办留出位置）：
 *   · 打开状态（顶栏「待办」可收起）下，这一列一直在 —— 没有清单时显示一句说明，
 *     而不是"没有就不渲染"：那样消息区会随清单出现/消失而忽宽忽窄，读起来很跳。
 *   · 它是**真实的一列**而不是浮层：有自己的滚动条、不盖住消息，与消息区之间隔 20px。
 *
 * 数据两条来源：打开会话/运行收尾时 GET /api/todo?sessionId=，运行中 SSE 的 todo 事件
 * 到达时直接替换（事件里就是整份清单，不必再请求）。
 * 窄屏（<sm）不占位 —— 手机上没有横向空间，只能靠顶栏按钮看清单（点开时给一句说明）。
 */
import { useApp } from '../state/store.js';
import { refreshTodo, toggleTodo } from '../state/session.js';
import { Btn, Icon, Spinner } from './ui.jsx';
import { fmtWhen } from '../lib/format.js';

const MARK = {
  done: { icon: 'check', cls: 'text-ok' },
  doing: { icon: 'refresh', cls: 'text-accent' },
  pending: { icon: 'stop', cls: 'text-subtle' },
};

export default function TodoPanel() {
  const st = useApp();
  if (!st.todoOpen) return null;
  const todo = st.todo;
  const items = Array.isArray(todo?.items) ? todo.items : [];
  const done = items.filter((i) => i.status === 'done').length;

  return (
    <aside className="ml-5 hidden w-64 shrink-0 flex-col py-2 sm:flex" aria-label="待办清单">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-card/95">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
          <Icon name="clipboard" className="size-3.5 text-accent" />
          <span className="text-xs font-medium">待办</span>
          {items.length ? (
            <span className="text-[10.5px] tabular-nums text-subtle">
              {done}/{items.length}
            </span>
          ) : null}
          <span className="flex-1" />
          <Btn variant="ghost" size="icon" className="size-6" onClick={() => void refreshTodo()} title="刷新">
            <Icon name="refresh" className="size-3" />
          </Btn>
          <Btn variant="ghost" size="icon" className="size-6" onClick={toggleTodo} title="收起（收起后消息区会占满）">
            <Icon name="close" className="size-3" />
          </Btn>
        </div>
        {/* 清单自己滚：长清单不会把这一列撑高，也不会带动别处 */}
        {items.length ? (
          <ul className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
            {items.map((it, i) => {
              const mark = MARK[it.status] ?? MARK.pending;
              return (
                <li key={`${i}-${it.text}`} className="flex items-start gap-1.5 py-0.5">
                  <span className={`mt-0.5 shrink-0 ${mark.cls}`}>
                    {it.status === 'doing' ? <Spinner className="size-3" /> : <Icon name={mark.icon} className="size-3" />}
                  </span>
                  <span className={`min-w-0 flex-1 text-[11.5px] leading-relaxed break-words ${it.status === 'done' ? 'text-subtle line-through' : it.status === 'doing' ? 'text-fg' : 'text-muted'}`}>{it.text}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
            <p className="text-[11px] leading-relaxed text-subtle">
              这个会话还没有待办。
              <br />
              多步任务时模型会用 <span className="font-mono">todo_write</span> 自己列一份，
              你也可以直接说"分几步做，列个清单"。
            </p>
          </div>
        )}
        {todo?.updated ? (
          <div className="shrink-0 border-t border-line px-2 py-1 text-right text-[10px] text-subtle">更新于 {fmtWhen(todo.updated)}</div>
        ) : null}
      </div>
    </aside>
  );
}
