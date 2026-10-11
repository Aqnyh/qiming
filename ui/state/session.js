/**
 * ui/state/session.js —— 会话与运行状态（界面唯一的动作入口）。
 *
 * 数据流与分工（对应需求 3/4/7）：
 *  · 登录 → /api/bootstrap 一次拉齐（设置/项目/会话/插件/提示词/技能/资源/在跑的运行）；
 *  · 打开会话 → /api/session/{id} 拉整条（含运行状态）；运行中的内容由 SSE 增量补；
 *  · 发消息 → /api/chat：会话没在跑就起一段运行，在跑就是**插话**（下一轮生效）；
 *  · 流式缓冲只留"给屏幕看的那点东西"：正文增量、思考最后 ~400 字、调用摘要；
 *    思考全文与工具参数/结果全文都不进内存，点开某条时现取（见 features/Message.jsx、TraceGroup.jsx）。
 *
 * 运行中的会话可能同时有**子智能体运行**（外部资源/子体工具触发）在同一 sessionId 上广播事件，
 * 这里用 runs[sessionId].runId 做闸门：只认主线运行的事件，子运行的只在 runs 里不占位、不串台。
 */
import { api, readToken, writeToken, setUnauthorizedHandler } from './api.js';
import { patch, state, toast, askConfirm } from './store.js';
import { connectEvents, disconnectEvents } from './events.js';
import { applyTheme, watchSystemTheme } from './theme.js';

let localSeq = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${++localSeq}`;

/**
 * 插入本地"乐观"用户消息 —— **先看服务端那条到了没有**（这是修掉的重复显示 bug）。
 *
 * 为什么需要这个检查：`/api/chat` 的响应与 SSE 的 `msg` 事件走两条通道，而服务端是
 * **先广播事件、后回响应**（run-loop 的首次 emit 在第一个 await 之前，是同步写出去的）。
 * 事件先到时，`state.msgs` 里已经有服务端那条了；这时再追加一条本地条，同一句话就显示两遍
 * （本地条不在服务端数据里，所以刷新后又只剩一条 —— 用户看到的就是"发出去两条、刷新变一条"）。
 */
function withOptimistic(msgs, text, extra = {}) {
  const steer = Boolean(extra.steer);
  const already = msgs.some((m) => m.role === 'user' && !m.local && Boolean(m.steer) === steer && m.content === text);
  if (already) return msgs;
  return [...msgs, { id: uid(steer ? 'steer' : 'local'), role: 'user', content: text, ts: Date.now(), local: true, ...extra }];
}

let booted = false;

/* ────────────────────────── 启动 / 登录 ────────────────────────── */

export async function boot() {
  // StrictMode 下 effect 会跑两遍；bootstrap 与 SSE 都只该初始化一次
  if (booted) return;
  booted = true;
  // 任何请求 401 的唯一出口：清令牌回登录页（api.js 里统一触发）
  setUnauthorizedHandler(() => {
    writeToken('');
    disconnectEvents();
    patch({ phase: 'login', sse: 'off', streams: {}, runs: {}, activeRun: null });
  });
  try {
    const auth = await api('/api/auth');
    patch({ auth });
    if (auth.authDisabled) {
      await enterApp(); // 自动化/信任场景直接进主界面
      return;
    }
    if (readToken()) {
      try {
        await enterApp();
      } catch (err) {
        writeToken('');
        patch({ phase: 'login', bootError: err?.status === 401 ? '' : err.message });
      }
      return;
    }
    patch({ phase: 'login' });
  } catch (err) {
    patch({ phase: 'login', bootError: err?.message ?? String(err) });
  }
}

export async function login(password) {
  // 密码校验失败服务端回 401（api.js 会顺手清一次本地令牌，无害）
  const r = await api('/api/auth', { method: 'POST', body: { password: String(password ?? '') } });
  if (r.token) writeToken(r.token);
  patch({ auth: { authenticated: r.authenticated, user: r.user, authDisabled: r.authDisabled, since: r.since }, bootError: '' });
  await enterApp();
}

export async function logout() {
  try {
    await api('/api/auth', { method: 'POST', body: { logout: true } });
  } catch {
    /* 服务端没注销成功也要清本地：不能留下一个用不了的令牌 */
  }
  writeToken('');
  disconnectEvents();
  patch({
    phase: 'login',
    auth: state.auth ? { ...state.auth, authenticated: false } : null,
    sse: 'off',
    sessions: [],
    runs: {},
    activeId: null,
    msgs: [],
    msgsFor: null,
    sessionMeta: null,
    activeRun: null,
    streams: {},
    todo: null,
    settings: null,
    projects: [],
  });
}

/**
 * 版本自检：构建前端时把当时的后端源码指纹写进了 bundle（__QIMING_STAMP__），
 * 服务进程启动时也算一次（GET /api/version）。两者不一致 = **新前端打旧后端**，
 * 症状是"点新按钮报没有这个接口" —— 与其让人猜，不如直接顶上挂一条"该重启了"。
 */
async function checkVersion() {
  try {
    const v = await api('/api/version');
    const app = typeof __QIMING_STAMP__ === 'undefined' ? '' : __QIMING_STAMP__;
    patch({ staleServer: app && v.stamp && app !== v.stamp ? { app, server: v.stamp, startedAt: v.startedAt } : null });
  } catch {
    patch({ staleServer: null }); // 旧到没有这个接口的进程：也别误报（下面 404 文案会提示重启）
  }
}

async function enterApp() {
  const b = await api('/api/bootstrap');
  const runs = {};
  for (const r of b.running ?? []) {
    if (r.parentRunId) continue; // 子智能体运行不占会话的"运行中"标记
    runs[r.sessionId] = { runId: r.id, startedAt: r.startedAt, status: r.status };
  }
  patch({
    phase: 'app',
    auth: b.auth ?? state.auth,
    settings: b.settings ?? null,
    projects: b.projects ?? [],
    projectsWorkspace: b.settings?.workspace ?? '',
    downloadsDir: b.downloadsDir ?? '',
    sessions: b.sessions ?? [],
    runs,
    bootError: '',
  });
  // 主题在**进主界面之前**就应用（否则会先闪一下默认配色）
  applyTheme(b.settings?.ui);
  watchSystemTheme(b.settings?.ui);
  connectEvents();
  void checkVersion();
  const first = state.sessions[0];
  if (first && !state.activeId) await openSession(first.id);
}

/* ────────────────────────── 列表与加载 ────────────────────────── */

export async function refreshSessions() {
  try {
    const r = await api('/api/sessions');
    patch({ sessions: r.sessions ?? [] });
  } catch {
    /* 列表刷新失败不打扰用户：对话本身照常 */
  }
}

export async function refreshProjects() {
  try {
    const r = await api('/api/projects');
    patch({ projects: r.projects ?? [], projectsWorkspace: r.workspace ?? state.projectsWorkspace });
  } catch {
    /* 同上 */
  }
}

/**
 * 新建会话。侧栏的「+」会带上项目 —— 服务端**当场建一条空会话**，
 * 这样它立刻出现在该项目分组下（否则要等第一条消息才落库，用户会以为没反应）。
 */
export async function newSession(projectId = null) {
  const pid = projectId || null;
  try {
    const r = await api('/api/sessions', { method: 'POST', body: { projectId: pid } });
    patch({
      activeId: r.session.id,
      msgs: [],
      msgsFor: r.session.id,
      sessionMeta: r.session,
      activeRun: null,
      todo: null,
      sidebarOpen: false,
      currentProjectId: pid ?? state.currentProjectId,
    });
    void refreshSessions();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ────────────────────────── 置顶 / 归档 ────────────────────────── */

export async function pinSession(id, pinned) {
  try {
    await api(`/api/session/${encodeURIComponent(id)}/pin`, { method: 'POST', body: { pinned } });
    await refreshSessions();
    toast(pinned ? '已置顶' : '已取消置顶', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function archiveSession(id, archived = true) {
  try {
    await api(`/api/session/${encodeURIComponent(id)}/archive`, { method: 'POST', body: { archived } });
    if (archived && state.activeId === id) {
      patch({ activeId: null, msgs: [], msgsFor: null, sessionMeta: null, todo: null });
    }
    await refreshSessions();
    toast(archived ? '已归档（在「设置 → 归档」里可恢复）' : '已恢复', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function pinProject(id, pinned) {
  try {
    await api(`/api/projects/${encodeURIComponent(id)}/pin`, { method: 'POST', body: { pinned } });
    await refreshProjects();
    toast(pinned ? '项目已置顶' : '已取消置顶', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function archiveProject(id, archived = true) {
  try {
    const r = await api(`/api/projects/${encodeURIComponent(id)}/archive`, { method: 'POST', body: { archived } });
    if (archived && state.sessionMeta?.projectId === id) {
      patch({ activeId: null, msgs: [], msgsFor: null, sessionMeta: null, todo: null });
    }
    // r.sessions 是**活跃**列表（服务端保证），正好是侧栏要的那份
    patch({ sessions: r.sessions ?? state.sessions });
    await refreshProjects();
    toast(
      archived ? `项目已归档${r.archivedCount ? `（连同 ${r.archivedCount} 条归档会话）` : ''}` : '项目与它的会话已恢复',
      'ok',
    );
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** 归档页：恢复 / 彻底删除 */
export async function refreshArchive() {
  return api('/api/archive');
}

export async function purgeSession(id) {
  await api(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshSessions();
}

export async function purgeProject(id) {
  await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshProjects();
  await refreshSessions();
}

export async function openSession(id) {
  if (!id) {
    newSession();
    return;
  }
  patch({ activeId: id, msgs: [], msgsFor: null, sessionMeta: null, activeRun: null, todo: null, sidebarOpen: false });
  await loadActive(id);
}

/** 拉当前会话整条（刷新后接管、运行收尾后对齐都走它） */
export async function loadActive(id = state.activeId) {
  if (!id) return;
  let data;
  try {
    data = await api(`/api/session/${encodeURIComponent(id)}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (state.activeId !== id) return; // 期间用户切走了，别把旧会话盖上来
  const streams = { ...state.streams };
  const runs = { ...state.runs };
  if (data.run && data.run.status === 'running') {
    runs[id] = { runId: data.run.id, startedAt: data.run.startedAt, status: 'running' };
  } else {
    // 没有在跑：本地残留的流式缓冲已经过时（服务端定稿的消息就在 session.msgs 里）
    delete streams[id];
    delete runs[id];
  }
  patch({
    msgs: data.session?.msgs ?? [],
    msgsFor: id,
    sessionMeta: data.session ?? null,
    activeRun: data.run ?? null,
    streams,
    runs,
    // 排队中的消息：服务端是唯一真源（刷新/换设备/别的标签页排的队都能看到）
    queue: { ...state.queue, [id]: Array.isArray(data.queue) ? data.queue : [] },
    // 上下文占用：不跑的时候也要有数（服务端按同一口径算的静态快照）
    ...(data.usage ? { usage: { ...state.usage, [id]: data.usage } } : {}),
    // 文件改动：刷新后"改过哪些文件"仍在（右列面板读它）
    ...(Array.isArray(data.changes) ? { changes: { ...state.changes, [id]: data.changes } } : {}),
    // 压缩替换节点：刷新后"哪段历史被摘要替掉了"仍可见、可撤回
    ...(Array.isArray(data.compact) ? { compact: { ...state.compact, [id]: data.compact } } : {}),
  });
  void refreshTodo(id);
}

export async function deleteSession(id) {
  if (!askConfirm('删除这条会话？聊天记录一并删除，不可恢复。')) return false;
  try {
    await api(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
  if (state.activeId === id) newSession();
  await refreshSessions();
  return true;
}

export function setCurrentProject(id) {
  patch({ currentProjectId: id || '' });
  void api('/api/projects', { method: 'POST', body: { current: id || null } }).catch(() => {
    /* 记住"当前项目"是顺手为之：服务端没记上也不影响本次会话用哪个项目 */
  });
}

/* ────────────────────────── 压缩替换节点（可见 + 可撤回） ────────────────────────── */

/** 撤回一个压缩节点：那段历史回到请求视图（原文一直在会话文件里，没有丢） */
export async function removeCompactNode(nodeId, sessionId = state.activeId) {
  if (!sessionId) return;
  try {
    const r = await api(`/api/session/${encodeURIComponent(sessionId)}/compact?node=${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
    patch({ compact: { ...state.compact, [sessionId]: Array.isArray(r.nodes) ? r.nodes : [] } });
    toast('已撤回该压缩节点（那段原历史重新进入请求视图）', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function refreshTodo(sessionId = state.activeId) {
  if (!sessionId) {
    patch({ todo: null });
    return;
  }
  try {
    const r = await api(`/api/todo?sessionId=${encodeURIComponent(sessionId)}`);
    if (state.activeId === sessionId) patch({ todo: r.todo ?? null });
  } catch {
    /* 清单拉不到不影响聊天 */
  }
}

/* ────────────────────────── 文件改动（比对与撤回） ────────────────────────── */

/** 拉这条会话的改动清单（检查点，新→旧） */
export async function refreshChanges(sessionId = state.activeId) {
  if (!sessionId) return;
  try {
    const r = await api(`/api/session/${encodeURIComponent(sessionId)}`);
    if (state.activeId !== sessionId) return; // 期间用户切走了
    patch({ changes: { ...state.changes, [sessionId]: Array.isArray(r.changes) ? r.changes : [] } });
  } catch {
    /* 改动清单拉不到不影响聊天 */
  }
}

/**
 * 撤回到某个检查点 —— **破坏性操作**，所以：
 *  1. 先让用户确认（会话在跑时服务端会直接拒绝，这里也先拦一道）；
 *  2. 撤完重拉清单（撤回本身也会留下一条新快照，历史只增不减）。
 */
export async function restoreCheckpoint(checkpoint, sessionId = state.activeId) {
  if (!sessionId) return false;
  if (state.runs[sessionId]) {
    toast('会话正在运行：先停止，再撤回（否则模型可能立刻又写回去）。', 'error');
    return false;
  }
  if (!askConfirm(`撤回到这一步之前的样子？\n\n· 这一步之后改的文件会被还原\n· 这一步之后新建的文件会被删除\n\n（撤回本身也会记一笔，可以再撤回来）`)) return false;
  try {
    const r = await api('/api/changes/restore', { method: 'POST', body: { sessionId, checkpoint } });
    toast(r.detail ?? '已撤回', 'ok');
    await refreshChanges(sessionId);
    await loadActive(sessionId); // 文件变了，让界面上的文件卡/详情重新对齐
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

/* ────────────────────────── 发送 / 停止 ────────────────────────── */

/**
 * 发消息。运行中发的一律**先收进队列**，三种语义由 `mode` 决定（见 run-types.ts 的 SteerMode）：
 *   · 不传 `mode` → **服务端用系统参数里的默认**（设置 → 系统 → queueDefault，默认 `queue`
 *     = 这一轮跑完自动接着执行）；这是"运行中再发一句"的常规行为。
 *   · `steer`（插话）—— 当前轮次的安全点注入，不打断；
 *   · `urgent`（立即执行）—— 掐掉当前模型调用/工具，立刻转向（**唯一在当前轮次内反馈**的做法）。
 * 排队条显示在输入框上方，**不进消息区**（没执行就不该出现在对话里）。
 */
export async function send(text, mode) {
  const body = { text: String(text ?? '').trim() };
  if (!body.text) return false;
  if (mode) body.mode = mode; // 不传 = 让服务端按系统默认决定
  const activeId = state.activeId;
  if (activeId) body.sessionId = activeId;
  else body.projectId = state.currentProjectId || null;

  let r;
  try {
    r = await api('/api/chat', { method: 'POST', body });
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
  if (!r.ok) {
    toast(r.error || '发送失败', 'error');
    return false;
  }
  const sid = r.sessionId;
  if (r.steered) {
    // 收进队列：只进"排队条"，不插消息气泡（执行时服务端会发 msg 事件，那时才出现在对话里）
    upsertQueued(sid, r.item ?? { id: uid('q'), text: body.text, ts: Date.now(), mode: r.mode ?? 'steer' });
    toast(
      r.mode === 'queue'
        ? '已排队：这一段运行跑完按顺序执行；可单条「立即执行」打断'
        : r.mode === 'urgent'
          ? '已请求打断：掐掉当前调用/工具后立刻转向'
          : '已插话：下一个安全点（每次工具跑完/模型调用后）就交给模型',
      'ok',
    );
    return true;
  }
  // 正常发送：先乐观插一条用户消息（服务端的 msg 事件到达时换成正身；若它已经先到了就不再插）
  const switched = state.activeId !== sid;
  const base = switched ? [] : state.msgs;
  const runs = { ...state.runs, [sid]: { runId: r.runId, startedAt: Date.now(), status: 'running' } };
  patch({
    activeId: sid,
    msgsFor: sid,
    runs,
    msgs: withOptimistic(base, body.text),
    ...(switched ? { sessionMeta: null, activeRun: null, todo: null } : {}),
  });
  void refreshSessions();
  return true;
}

/* ────────────────────────── 排队队列 ────────────────────────── */

/**
 * 把一条排队条目放进本地队列（按 id 去重/更新）。
 * 为什么必须去重：入队会从**两条通道**回来 —— POST 的响应体（带 item）与 SSE 的 `queued` 广播，
 * 谁先到不定；不去重就会出现"排队条里两条一模一样"（实测踩到过）。
 */
function upsertQueued(sessionId, item) {
  if (!sessionId || !item?.id) return;
  const cur = state.queue[sessionId] ?? [];
  const next = cur.some((i) => i.id === item.id)
    ? cur.map((i) => (i.id === item.id ? { ...i, ...item } : i))
    : [...cur, item];
  patch({ queue: { ...state.queue, [sessionId]: next } });
}

export function queueOf(sessionId = state.activeId) {
  return sessionId ? (state.queue[sessionId] ?? []) : [];
}

async function queueAction(sessionId, id, action) {
  try {
    const r = await api('/api/run/queue', { method: 'POST', body: { sessionId, id, action } });
    patch({ queue: { ...state.queue, [sessionId]: r.items ?? [] } });
    if (action === 'execute') toast('已请求立即执行：会打断当前调用，把它插到最前', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** 从队列里删掉一条（还没执行的消息，删了就当没说过） */
export async function removeQueued(id, sessionId = state.activeId) {
  if (sessionId) await queueAction(sessionId, id, 'remove');
}

/** 立即执行：打断当前模型调用，把这条插到最前 */
export async function executeQueued(id, sessionId = state.activeId) {
  if (sessionId) await queueAction(sessionId, id, 'execute');
}

export async function stopRun(sessionId = state.activeId) {
  if (!sessionId) return;
  try {
    await api('/api/run/stop', { method: 'POST', body: { sessionId } });
    toast('已请求停止', 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ────────────────────────── 抽屉与浮层的开合 ────────────────────────── */

/**
 * 把"当前开着哪个抽屉"写到 <html data-drawer>。
 * 为什么不用 React 渲染：手机上的两枚按键（会话 / 设置）是**兄弟节点**，
 * 要互斥就得让一个知道另一个的状态；写到一个 DOM 属性上，既让 CSS 能选中，
 * 也让真机检查（test/ui-check.mjs）能直接量出来，不必猜。
 */
function markDrawer(which) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (which) el.dataset.drawer = which;
  else delete el.dataset.drawer;
}

/** 手机上的两个抽屉互斥：开一个就把另一个收起来（否则遮罩会叠在一起） */
export function openDrawer(section) {
  patch({
    drawer: { open: true, section: section ?? state.drawer.section },
    sidebarOpen: false,
  });
  markDrawer('settings');
  scrollDrawerNavTo(section);
}
export function closeDrawer() {
  patch({ drawer: { ...state.drawer, open: false } });
  markDrawer(null);
}
export function setDrawerSection(section) {
  patch({ drawer: { open: true, section } });
  markDrawer('settings');
  scrollDrawerNavTo(section);
}

/**
 * 打开设置时把选中的板块页签滚进可视区（手机那排页签是横向滚动的，
 * 从「模型」进来却停在「插件」那一端会让人以为没切过去）。
 */
function scrollDrawerNavTo(section) {
  if (!section || typeof document === 'undefined') return;
  requestAnimationFrame(() => {
    const btn = document.querySelector(`[data-section="${section}"]`);
    if (btn?.scrollIntoView) btn.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
}
export function openDownloads() {
  patch({ downloads: true });
}
export function closeDownloads() {
  patch({ downloads: false });
}

/* 「文件改动」大抽屉：开着时右列那条入口点不开第二次，关掉回到入口条 */
export function openChanges() {
  patch({ changesOpen: true });
}
export function closeChanges() {
  patch({ changesOpen: false });
}
export function toggleSidebar() {
  const open = !state.sidebarOpen;
  // 开手机侧栏时把设置抽屉收掉：两个都是 fixed 全高抽屉，同开会让遮罩叠遮罩
  patch(open ? { sidebarOpen: true, drawer: { ...state.drawer, open: false } } : { sidebarOpen: false });
  markDrawer(open ? 'sessions' : null);
}
export function closeSidebar() {
  patch({ sidebarOpen: false });
  markDrawer(null);
}
export function toggleTodo() {
  const open = !state.todoOpen;
  patch({ todoOpen: open });
  // 窄屏（<sm）抽屉不占位，点「待办」需要一句说明；宽屏有常驻面板（空时自己带说明），不再弹 toast
  const narrow = typeof window !== 'undefined' && window.matchMedia && !window.matchMedia('(min-width: 640px)').matches;
  if (open && narrow) {
    void refreshTodo().then(() => {
      if (!state.todo) toast('这个会话还没有待办清单（模型用 todo_write 维护，任务多步时会自己列）', 'info');
    });
  }
}

/* ────────────────────────── SSE 事件分流（唯一入口） ────────────────────────── */

function ensureStream(sessionId, runId, msgId) {
  const streams = { ...state.streams };
  streams[sessionId] = {
    sessionId,
    runId,
    msgId,
    startedAt: Date.now(),
    content: '',
    thinkingChars: 0,
    thinkingTail: '',
    calls: [],
    notices: [],
    stats: null,
    /** 当前 turn / step（服务端 round 事件带的：turn = 用户输入划的段，step = 段内模型调用序号） */
    turn: 1,
    step: 0,
    steers: [],
    ended: false,
  };
  patch({ streams });
  return streams[sessionId];
}

/** 事件带的 (runId,msgId) 与当前缓冲不一致 → 换一条新缓冲（接管/子运行过滤后的主线） */
function updateStream(ev, fn) {
  let cur = state.streams[ev.sessionId];
  if (!cur || cur.runId !== ev.runId || (ev.msgId && cur.msgId !== ev.msgId)) {
    if (!ev.msgId) return;
    cur = ensureStream(ev.sessionId, ev.runId, ev.msgId);
  }
  const next = fn({ ...cur });
  patch({ streams: { ...state.streams, [ev.sessionId]: next } });
}

function upsertCall(calls, call) {
  const list = (calls ?? []).slice();
  const i = list.findIndex((c) => c.seq === call.seq);
  if (i >= 0) list[i] = { ...list[i], ...call };
  else list.push(call);
  return list;
}

export function applyEvent(ev) {
  if (!ev || !ev.type || !ev.sessionId) return;
  const sid = ev.sessionId;
  const known = state.runs[sid];

  /* 闸门：同一会话可能并行着子智能体运行（同 sessionId 广播）——只认主线那条 */
  if (ev.type === 'run_started') {
    if (known && known.runId !== ev.runId) return;
    if (!known) patch({ runs: { ...state.runs, [sid]: { runId: ev.runId, startedAt: ev.ts ?? Date.now(), status: 'running' } } });
    if (ev.msgId) ensureStream(sid, ev.runId, ev.msgId);
    return;
  }
  if (known && known.runId !== ev.runId) return;

  switch (ev.type) {
    case 'thinking':
      updateStream(ev, (s) => ({
        ...s,
        thinkingChars: s.thinkingChars + (ev.text?.length ?? 0),
        // 只留最后 ~400 字做预览：思考全文在服务端，点开时才取（需求 7 的内存纪律）
        thinkingTail: `${s.thinkingTail}${ev.text ?? ''}`.slice(-400),
      }));
      return;
    case 'content':
      updateStream(ev, (s) => ({ ...s, content: s.content + (ev.text ?? '') }));
      return;
    case 'call':
    case 'call_done':
      updateStream(ev, (s) => ({ ...s, calls: upsertCall(s.calls, ev.call) }));
      return;
    case 'round':
      updateStream(ev, (s) => ({
        ...s,
        ...(ev.turn ? { turn: ev.turn } : {}),
        ...(ev.step ? { step: ev.step } : {}),
        stats: {
          in: (s.stats?.in ?? 0) + (ev.stats?.in ?? 0),
          out: (s.stats?.out ?? 0) + (ev.stats?.out ?? 0),
          ms: (s.stats?.ms ?? 0) + (ev.stats?.ms ?? 0),
        },
      }));
      return;
    /* 上下文占用：服务端用真分词算好的快照（系统/消息/工具表/预留 + 百分比）。
       只存数字、不发明细文本，所以更新很便宜。 */
    case 'usage':
      if (ev.usage) patch({ usage: { ...state.usage, [sid]: ev.usage } });
      return;
    case 'notice':
      updateStream(ev, (s) => ({ ...s, notices: [...s.notices, String(ev.text ?? '')] }));
      return;
    case 'msg':
      onServerMessage(sid, ev.msg);
      return;
    case 'steer': {
      /* queued = 有人（可能是别的设备，也可能是我自己）把它排进了队 → 按 id 上插/更新；
         taken = 这一轮把它取走执行了 → 从排队条摘掉（消息本身随后由 msg 事件落进对话，那时才可见）。 */
      const cur = state.queue[sid] ?? [];
      if (ev.state === 'taken') {
        patch({ queue: { ...state.queue, [sid]: cur.filter((i) => i.id !== ev.id && i.text !== ev.text) } });
        return;
      }
      if (!ev.id) return;
      const exists = cur.some((i) => i.id === ev.id);
      upsertQueued(sid, exists ? { id: ev.id, mode: ev.mode ?? 'steer' } : { id: ev.id, text: ev.text, ts: Date.now(), mode: ev.mode ?? 'steer' });
      return;
    }
    case 'todo':
      if (sid === state.activeId) patch({ todo: ev.items ? { sessionId: sid, items: ev.items, updated: Date.now() } : null });
      return;
    /* 文件改动：工具动手前后会广播一条检查点（打快照 / 撤回）。
       清单本身有界（一次工具调用最多几十个文件），直接重拉整份最省心，也不必在前端做归并。 */
    case 'checkpoint':
      void refreshChanges(sid);
      return;
    case 'run_end': {
      if (state.streams[sid] && state.streams[sid].runId !== ev.runId) return; // 子运行的收尾
      const runs = { ...state.runs };
      if (runs[sid]?.runId === ev.runId) delete runs[sid];
      const streams = { ...state.streams };
      delete streams[sid];
      patch({ runs, streams });
      if (ev.status === 'error' && ev.error) toast(`运行出错：${ev.error}`, 'error');
      if (sid === state.activeId) {
        void loadActive(sid); // 用服务端落盘结果整份对齐（停止/出错也走这里）
        void refreshTodo(sid);
        void refreshChanges(sid);
      }
      void refreshSessions();
      return;
    }
    default:
      /* 未知事件类型不当作错误（服务端以后加事件不该让前端崩） */
  }
}

/** `msg`：服务端定稿消息 —— 用户消息换掉本地乐观条，助手消息替换整段流式缓冲 */
function onServerMessage(sid, msg) {
  if (!msg) return;
  if (msg.role === 'user') {
    if (sid === state.activeId && state.msgsFor === sid) {
      const msgs = state.msgs.slice();
      // 本地乐观条：普通消息按内容匹配，插话消息也要换掉（否则刷新前会出现两条一样的）
      const li = msgs.findIndex((m) => m.local && m.role === 'user' && Boolean(m.steer) === Boolean(msg.steer) && m.content === msg.content);
      if (li >= 0) msgs[li] = { ...msg, local: false };
      else if (!msgs.some((m) => m.id === msg.id)) msgs.push(msg);
      patch({ msgs });
    }
    void refreshSessions(); // 首条消息会定标题
    return;
  }
  const streams = { ...state.streams };
  delete streams[sid];
  if (sid === state.activeId && state.msgsFor === sid) {
    const msgs = state.msgs.filter((m) => m.id !== msg.id);
    msgs.push(msg);
    patch({ streams, msgs });
  } else {
    patch({ streams });
  }
}
