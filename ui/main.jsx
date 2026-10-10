/**
 * ui/main.jsx —— 前端入口：装 React、按 phase 切三态（启动中 / 登录 / 主界面）。
 *
 * 状态都在 state/ 里，这里只做"把哪个界面画出来"的路由。
 */
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp } from './state/store.js';
import { boot } from './state/session.js';
import Login from './features/Login.jsx';
import Header from './features/Header.jsx';
import Sidebar from './features/Sidebar.jsx';
import ChatView from './features/ChatView.jsx';
import SettingsDrawer from './features/SettingsDrawer.jsx';
import DownloadsDialog from './features/DownloadsDialog.jsx';
import { Icon, Spinner, Toast } from './features/ui.jsx';

function Splash({ text }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg text-muted">
      <div className="flex items-center gap-2 text-sm">
        <Spinner className="size-4 text-accent" />
        {text}
      </div>
    </div>
  );
}

function App() {
  const st = useApp();
  useEffect(() => {
    void boot();
  }, []);

  if (st.phase === 'boot') return <Splash text="启明启动中…" />;
  if (st.phase === 'login') return <Login />;

  return (
    // overflow-hidden：整个窗口不滚，滚动只发生在各区域内部（侧栏/消息区/待办）
    <div className="app-shell flex h-dvh overflow-hidden text-fg">
      {/* 左侧一栏通到窗口顶部：启明在最上方；右侧顶栏只压着会话列（ZCode 同构） */}
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Header />
        {st.staleServer ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[11.5px] text-warn">
            <Icon name="refresh" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              服务端还是**旧进程**（前端构建指纹 {st.staleServer.app} ≠ 服务端 {st.staleServer.server}）——
              新加的功能会报「没有这个接口」。跑一次 <span className="font-mono">bash down.sh && bash up.sh</span> 就好（重启后要重新登录）。
            </span>
          </div>
        ) : null}
        <ChatView />
      </div>
      {st.drawer.open ? <SettingsDrawer /> : null}
      {st.downloads ? <DownloadsDialog /> : null}
      <Toast toast={st.toast} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
