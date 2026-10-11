/**
 * test/ui-check.mjs —— 界面真机检查（真实 Chrome + CDP，自带沙箱站点）。
 *
 *   node test/ui-check.mjs
 *
 * 为什么要有它：这一轮修的是**布局与滚动的毛病**（滚消息时会话区跟着动），
 * 而这类问题单测看不见、只有真实浏览器能验：文档到底滚不滚、三块区域是不是各自滚、
 * 两个 20px 间距对不对、顶栏与侧栏的下边框有没有对齐。
 *
 * 姿势（都是踩过的坑）：
 *  · 悬停必须开 `--blink-settings=primaryHoverType=2,…`（无头 Chrome 自报 (hover:none)，hover: 全失效）；
 *  · 用 CDP 的 Input.dispatchMouseEvent 派发真鼠标移动，不能只改 CSS；
 *  · 收尾把页面导航到 about:blank，别留着一个开着 SSE 的窗口（会顶掉下一次检查的窗口）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qiming-ui-'));
const PORT = await freePort();
const CDP = 9337;

let chrome;
let server;
let upstream;
let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✔ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✖ ${label}${extra ? ` —— ${extra}` : ''}`);
  }
}

function freePort() {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/* ────────────────────────── CDP 小客户端 ────────────────────────── */

function connect() {
  let id = 0;
  const pending = new Map();
  let ws;
  const open = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) {
          ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((r, j) => {
            ws.addEventListener('open', r, { once: true });
            ws.addEventListener('error', j, { once: true });
          });
          ws.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            if (m.id && pending.has(m.id)) {
              pending.get(m.id)(m.result);
              pending.delete(m.id);
            }
          });
          return;
        }
      } catch {
        /* Chrome 还没起来 */
      }
      await sleep(250);
    }
    throw new Error('连不上 Chrome 调试端口');
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  const evaluate = async (expr) =>
    (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
  return { open, send, evaluate, close: () => ws?.close() };
}

/* ────────────────────────── 起环境 ────────────────────────── */

console.log('起服务与浏览器…');
server = spawn('node', ['server.ts'], {
  cwd: ROOT,
  env: { ...process.env, QIMING_DATA: TMP, QIMING_AUTH: 'off', PORT: String(PORT), HOST: '127.0.0.1', QIMING_LOG: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // 独立进程组：本脚本被 timeout/中断掐死时，下面这几个信号处理器能把它整组带走
});
const cleanup = () => {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  try { chrome?.kill('SIGKILL'); } catch { /* 已退出 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('exit', cleanup);
const logs = [];
server.stdout.on('data', (c) => logs.push(String(c)));
server.stderr.on('data', (c) => logs.push(String(c)));
for (let i = 0; i < 80 && !logs.join('').includes('启明已启动'); i++) await sleep(150);

/* 慢流假上游：排队条只在"运行中"出现，所以需要一个能跑一会儿的运行。
   60s 的窗口 —— 检查脚本的步骤多，窗口太短会偶发。
   另外支持一个"用工具写文件"的标记：那一路会先发一个 write_file 调用（用来造出
   真实的文件改动检查点，供「文件改动」抽屉的检查用），再给最终回答。 */
upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = msgs.at(-1);
    const wantTool = String(last?.content ?? '').includes('用工具写文件') && !msgs.some((m) => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (wantTool) {
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ tool_calls: [{ index: 0, id: 'call_ui1', type: 'function', function: { name: 'write_file', arguments: '{"path":"out/ui-note.txt","content":"界面检查用的文件\\n"}' } }] });
      chunk({}, 'tool_calls');
      return res.end('data: [DONE]\n\n');
    }
    if (msgs.some((m) => m.role === 'tool')) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '已写好文件。' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    let i = 0;
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(timer);
      i += 1;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `慢${i}…` }, finish_reason: null }] })}\n\n`);
      if (i >= 200) {
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    }, 300);
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
await api('POST', '/api/settings', {
  providers: [{ id: 'slow', name: '慢流假上游', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'slow-1', apiKey: 'k' }],
  activeId: 'slow',
});

// 造内容：一个项目、两条会话（一条长、一条置顶）、一条归档、一份待办
const proj = await api('POST', '/api/projects', { root: ROOT, name: '界面检查项目' });
const projectId = proj.json.project.id;
const s1 = (await api('POST', '/api/sessions', { projectId })).json.session.id;
const s2 = (await api('POST', '/api/sessions', { projectId })).json.session.id;
const s3 = (await api('POST', '/api/sessions', { projectId: null })).json.session.id;
await api('POST', `/api/session/${s2}/pin`, { pinned: true });
await api('POST', `/api/session/${s3}/archive`, { archived: true });

// 长会话直接写文件（服务端每次读 sessions.json，没有缓存）
{
  const file = path.join(TMP, 'sessions.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = d.sessions.find((x) => x.id === s1);
  s.title = '长会话：验证滚动';
  const ts = Date.now();
  s.msgs = [];
  for (let i = 1; i <= 6; i++) {
    s.msgs.push({ id: `m_u${i}`, role: 'user', content: `第 ${i} 个问题`, ts: ts + i });
    s.msgs.push({
      id: `m_a${i}`,
      role: 'assistant',
      content: `第 ${i} 段的回答。\n\n${'补充说明。'.repeat(30)}`,
      ts: ts + i,
      stats: { in: 10, out: 20, ms: 100 },
    });
  }
  s.updatedAt = ts + 100;
  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`, 'utf8');
}
// 附件顺序验证：一条消息里"先说一句 → 发图 → 再说一句 → 再发图"
{
  const downloads = path.join(TMP, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  // 1×1 PNG（够渲染即可）
  fs.writeFileSync(
    path.join(downloads, '顺序一.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'),
  );
  fs.writeFileSync(path.join(downloads, '顺序二.png'), fs.readFileSync(path.join(downloads, '顺序一.png')));

  const file = path.join(TMP, 'sessions.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sess = d.sessions.find((x) => x.id === s1);
  const first = '第一句话。';
  const second = '第二句话。';
  const content = first + second;
  sess.msgs.push({
    id: 'm_order_u',
    role: 'user',
    content: '把两张图按顺序发我。',
    ts: Date.now(),
  });
  sess.msgs.push({
    id: 'm_order',
    role: 'assistant',
    content,
    ts: Date.now(),
    stats: { in: 1, out: 1, ms: 1 },
    calls: [
      { seq: 90, contentAt: first.length, name: 'send_media', label: '媒体消息 · send_media', plugin: 'media', argsDigest: '{}', state: 'ok', ms: 1, digest: '媒体（image）', media: [{ kind: 'image', download: '顺序一.png', caption: '第一张' }] },
      { seq: 91, contentAt: content.length, name: 'send_media', label: '媒体消息 · send_media', plugin: 'media', argsDigest: '{}', state: 'ok', ms: 1, digest: '媒体（image）', media: [{ kind: 'image', download: '顺序二.png', caption: '第二张' }] },
    ],
  });
  sess.updatedAt = Date.now() + 1000;
  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`, 'utf8');
}

await api('POST', '/api/todo', {
  sessionId: s1,
  items: Array.from({ length: 8 }, (_, i) => ({ text: `待办条目 ${i + 1}`, status: i === 0 ? 'done' : 'pending' })),
});

chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    // 无头 Chrome 默认自报 (hover:none) → hover: 类全失效；这两组开关把它改回"有鼠标"
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    `--remote-debugging-port=${CDP}`,
    '--user-data-dir=/tmp/qiming-ui-check-profile',
    '--window-size=1680,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const cdp = connect();
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(5200);

/* ────────────────────────── 检查 ────────────────────────── */

// 先打开"长会话"：消息区要有内容才谈得上滚动，待办面板也只在当前会话有清单时出现
await cdp.evaluate(`(() => {
  const row = [...document.querySelectorAll('[data-region="sessions"] div')].find(r => r.className.includes('cursor-pointer') && r.textContent.includes('长会话'));
  row?.click();
  return Boolean(row);
})()`);
await sleep(1800);

console.log('\n【布局】');
const layout = await cdp.evaluate(`(() => {
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const side = box('aside');
  const header = box('header');
  const brand = box('aside > div');
  const scroller = box('[data-region="messages"]');
  return JSON.stringify({ side, header, brand, docScroll: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight });
})()`);
const L = JSON.parse(layout);
ok(Math.abs(L.brand.h - L.header.h) < 1, `顶栏与侧栏品牌行等高（${L.header.h} vs ${L.brand.h}）`);
ok(Math.abs(L.brand.bottom - L.header.bottom) < 1, '两边的下边框在同一条线上');
ok(L.docScroll <= 1, `整个文档不滚动（可滚高度 ${L.docScroll}px）`);

console.log('\n【20px 间距】');
const gaps = await cdp.evaluate(`(() => {
  const r = (el) => el.getBoundingClientRect();
  const side = document.querySelector('aside');
  const scroller = document.querySelector('[data-region="messages"]');
  const todo = document.querySelector('aside[aria-label="待办清单"]');
  return JSON.stringify({
    sidebarToMessages: Math.round(r(scroller).x - r(side).right),
    messagesToTodo: todo ? Math.round(r(todo).x - r(scroller).right) : null,
  });
})()`);
const G = JSON.parse(gaps);
ok(Math.abs(G.sidebarToMessages - 20) <= 1, `会话区 → 消息区 = ${G.sidebarToMessages}px`);
ok(G.messagesToTodo !== null && Math.abs(G.messagesToTodo - 20) <= 1, `消息区 → 待办区 = ${G.messagesToTodo}px`);

// 需求：右侧要给待办留出位置 —— 切到**没有清单**的会话，这一列也得在（否则消息区忽宽忽窄）
await cdp.evaluate(`(() => {
  const row = [...document.querySelectorAll('[data-region="sessions"] div')].find(r => r.className.includes('cursor-pointer') && r.textContent.includes('新会话'));
  row?.click();
  return Boolean(row);
})()`);
await sleep(1600);
const emptyTodo = await cdp.evaluate(`(() => {
  const side = document.querySelector('aside[aria-label="待办清单"]');
  const text = side ? side.innerText.replace(/\s+/g, ' ').slice(0, 40) : '';
  return JSON.stringify({ present: Boolean(side), width: side ? Math.round(side.getBoundingClientRect().width) : 0, text, hasItems: Boolean(side && side.querySelector('li')) });
})()`);
const ET = JSON.parse(emptyTodo);
ok(ET.present && ET.width > 100, `没有待办的会话也留出了待办列（宽 ${ET.width}px）`);
ok(ET.present && !ET.hasItems && ET.text.includes('还没有待办'), '空清单时给一句说明，而不是整列消失');
// 切回长会话，后面的滚动检查继续用它
await cdp.evaluate(`(() => {
  const row = [...document.querySelectorAll('[data-region="sessions"] div')].find(r => r.className.includes('cursor-pointer') && r.textContent.includes('长会话'));
  row?.click();
  return Boolean(row);
})()`);
await sleep(1600);

console.log('\n【四个区域各自滚动】');
const readScroll = () => cdp.evaluate(`(() => {
  const nav = document.querySelector('[data-region="sessions"]');
  const scroller = document.querySelector('[data-region="messages"]');
  const todoList = document.querySelector('aside[aria-label="待办清单"] ul');
  const doc = document.scrollingElement;
  return JSON.stringify({
    nav: nav.scrollTop, msg: scroller.scrollTop, todo: todoList ? todoList.scrollTop : 0, doc: doc.scrollTop,
    navScrollable: nav.scrollHeight > nav.clientHeight,
    todoScrollable: Boolean(todoList) && todoList.scrollHeight > todoList.clientHeight,
    msgScrollable: scroller.scrollHeight > scroller.clientHeight,
  });
})()`);
const before = JSON.parse(await readScroll());
await cdp.evaluate(`document.querySelector('[data-region="messages"]').scrollTop = 200`);
await sleep(150);
const afterMsg = JSON.parse(await readScroll());
await cdp.evaluate(`document.querySelector('[data-region="sessions"]').scrollTop = 60`);
await sleep(150);
const afterNav = JSON.parse(await readScroll());
await cdp.evaluate(`(() => { const u = document.querySelector('aside[aria-label="待办清单"] ul'); if (u) u.scrollTop = 40; })()`);
await sleep(150);
const afterTodo = JSON.parse(await readScroll());
const S = {
  before,
  after: { nav: afterMsg.nav, msg: afterMsg.msg, todo: afterMsg.todo, doc: afterMsg.doc },
  navMoved: afterNav.nav,
  todoMoved: afterTodo.todo,
  navScrollable: before.navScrollable,
  todoScrollable: before.todoScrollable,
  msgScrollable: before.msgScrollable,
};
ok(S.after.msg !== S.before.msg, '消息区能滚（scrollTop 变了）');
ok(S.after.nav === S.before.nav, '滚消息区时**会话区不动**（这是修掉的 bug）');
ok(S.after.doc === S.before.doc && S.after.doc === 0, '滚消息区时整个文档不动');
ok(S.msgScrollable, '消息区确实有滚动条（内容比容器长）');
ok(!S.navScrollable || S.navMoved > 0, '会话区有滚动条且能自己滚');
ok(!S.todoScrollable || S.todoMoved > 0, '待办清单有滚动条且能自己滚');

console.log('\n【文件改动面板】');
/* 需求：改过哪些文件要能在界面上看到（列表 + diff + 撤回），
   数据来自影子 git 检查点（src/store/checkpoints.ts）。
   现在右列只留一条入口，点开是**右侧大抽屉**（右列 256px 放不下行号与并排视图）。
   这里只管"入口 → 抽屉 → 结构"；diff 的数据正确性由 e2e 的
   「文件改动：结构化 diff」用例守着（真改文件、真取 diff）。 */
{
  const P = JSON.parse(await cdp.evaluate(`(() => {
    const entry = document.querySelector('[aria-label="文件改动"]');
    const right = document.querySelector('[aria-label="右列"]');
    const drawer = document.querySelector('[role="dialog"][aria-label="文件改动"]');
    return JSON.stringify({
      hasEntry: Boolean(entry),
      inRightCol: Boolean(right && entry && right.contains(entry)),
      hasTodo: Boolean(document.querySelector('[aria-label="待办清单"]')),
      entryText: entry ? entry.innerText.replace(/\\s+/g, ' ').slice(0, 40) : '',
      drawerOpen: Boolean(drawer),
    });
  })()`));
  ok(P.hasEntry, '右列有「文件改动」入口');
  ok(P.inRightCol, '入口挂在右列（与待办同列，不盖住消息）');
  ok(P.hasTodo, '待办面板还在（两者共存）');
  ok(/文件改动/.test(P.entryText), `入口标题正确（实际：${P.entryText}）`);
  ok(!P.drawerOpen, '默认不展开大抽屉（点开才显示）');

  // 点开入口 → 抽屉出现（占大半屏）
  await cdp.evaluate(`(() => { document.querySelector('[aria-label="文件改动"]').click(); return true; })()`);
  await sleep(1000);
  const D = JSON.parse(await cdp.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"][aria-label="文件改动"]');
    if (!d) return JSON.stringify({ open: false });
    const r = d.getBoundingClientRect();
    return JSON.stringify({
      open: true,
      wide: Math.round(r.width),
      vw: window.innerWidth,
      inRight: r.left > 0,
      text: d.innerText.replace(/\\s+/g, ' ').slice(0, 80),
    });
  })()`));
  ok(D.open, '点击入口打开大抽屉');
  ok(D.wide / D.vw > 0.6, `抽屉够宽（${D.wide}/${D.vw}，要占大半屏才放得下 diff）`);
  ok(D.inRight, '抽屉靠右（与设置抽屉同一侧）');
  ok(/检查点/.test(D.text ?? ''), `抽屉里是检查点视图（实际：${(D.text ?? '').slice(0, 40)}）`);

  // Esc 关闭
  await cdp.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(600);
  const closed = await cdp.evaluate(`!document.querySelector('[role="dialog"][aria-label="文件改动"]')`);
  ok(closed, 'Esc 能关掉抽屉');
}

console.log('\n【文件改动：真实 diff 渲染】');
/* 上面只验了空状态。这里让假上游真的写一次文件（走 write_file 工具），
   再看抽屉里是不是**真的画出了 diff**：行号双列、增删底色、视图切换、折叠条。
   空抽屉看着永远"对"，diff 的坑全在有数据的时候（行号、折叠、并排配对）。 */
{
  const sid = (await api('POST', '/api/sessions', { projectId })).json.session.id;
  /* 假上游写的是项目根目录下的 out/ui-note.txt，而项目根就是本工程 ——
     上一轮检查留下的同名文件必须清掉，否则"再写一遍同样的内容"**没有差异**，
     抽屉当然是空的（这个坑踩过一次：看着像界面没渲染，其实是 diff 真的为空）。 */
  const notePath = path.join(ROOT, 'out', 'ui-note.txt');
  try { fs.rmSync(notePath, { force: true }); } catch { /* 忽略 */ }
  await api('POST', '/api/chat', { sessionId: sid, text: '用工具写文件' });
  // 等运行收尾（假上游写完文件后给最终回答）
  for (let i = 0; i < 60; i++) {
    const s = await api('GET', `/api/session/${sid}`);
    const last = s.json.session.msgs.at(-1);
    if (last?.role === 'assistant' && last.stats) break;
    await sleep(250);
  }
  const changes = (await api('GET', `/api/session/${sid}`)).json.changes ?? [];
  ok(changes.length > 0, `写文件后产生检查点（实际 ${changes.length} 条）`);
  // 接口层先确认真的能算出 diff（否则前端没东西可画，问题不在界面）
  let apiFiles = 0;
  for (const cp of changes) {
    const d = await api('GET', `/api/changes/diff?sessionId=${sid}&checkpoint=${cp.id}`);
    apiFiles += (d.json.files ?? []).length;
  }
  ok(apiFiles > 0, `接口能算出文件差异（实际 ${apiFiles} 个文件）`);

  /* 这条会话是页面加载之后才建的，侧栏里还没有它 —— 刷新一次让列表重新拉，
     再点开它（沿用上面那句"点会话行"的写法：行是 cursor-pointer 的 div）。 */
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(5200);
  const title = (await api('GET', `/api/session/${sid}`)).json.session.title ?? '';
  const clicked = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-region="sessions"] div')]
      .find((r) => r.className.includes('cursor-pointer') && r.textContent.includes(${JSON.stringify(title)}));
    row?.click();
    return Boolean(row);
  })()`);
  ok(clicked, `能在侧栏点开刚改过文件的会话（标题：${title}）`);
  await sleep(1500);
  await cdp.evaluate(`(() => { document.querySelector('[aria-label="文件改动"]')?.click(); return true; })()`);
  await sleep(1500);

  const R = JSON.parse(await cdp.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"][aria-label="文件改动"]');
    if (!d) return JSON.stringify({ open: false });
    const text = d.innerText.replace(/\\s+/g, ' ');
    // 行号：等宽小字、tabular-nums 的那批（Gutter 组件）
    const gutters = [...d.querySelectorAll('.tabular-nums')].map((n) => (n.textContent || '').trim()).filter((t) => /^\\d+$/.test(t));
    // 增删行：底色类（bg-ok/10 与 bg-danger/10）
    const adds = [...d.querySelectorAll('.text-ok')].length;
    const dels = [...d.querySelectorAll('.text-danger')].length;
    // 并排/统一切换按钮
    const views = [...d.querySelectorAll('button')].map((b) => b.innerText.trim());
    return JSON.stringify({
      open: true,
      hasPath: /out\\/ui-note\\.txt/.test(text),
      hasPlus: /\\+1/.test(text),
      gutters,
      adds, dels,
      hasUnified: views.includes('统一'),
      hasSplit: views.includes('并排'),
      hasStat: /个文件/.test(text),
    });
  })()`));
  ok(R.open, '抽屉能打开');
  ok(R.hasPath, '画出了改动的文件路径（out/ui-note.txt）');
  ok(R.gutters.length > 0, `渲染了行号（实际 ${R.gutters.length} 个数字行号）`);
  ok(R.gutters.includes('1'), `新增行的行号从 1 起（实际 ${JSON.stringify(R.gutters.slice(0, 6))}）`);
  ok(R.adds > 0, '新增行有增色（text-ok）');
  ok(R.hasUnified && R.hasSplit, '统一 / 并排两个视图都在');
  ok(R.hasStat, '顶部有"N 个文件"的统计');

  /* 切到并排视图：左右两栏都出现（并排是这次新加的渲染路径）。
     先挂个全局错误钩子 —— 渲染期抛异常时 React 会把整棵子树卸载（抽屉直接消失），
     只看"元素不见了"根本不知道为什么，必须把报错捞出来。 */
  await cdp.evaluate(`(() => {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.error || e)));
    return true;
  })()`);
  await cdp.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"][aria-label="文件改动"]');
    const b = [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === '并排');
    b?.click();
    return true;
  })()`);
  await sleep(500);
  const S = JSON.parse(await cdp.evaluate(`(() => {
    try {
      const d = document.querySelector('[role="dialog"][aria-label="文件改动"]');
      if (!d) return JSON.stringify({ halves: 0, stillHasPath: false, note: '抽屉不见了' });
      // 并排视图里每一行是"左右各 50%"的两栏
      const halves = [...d.querySelectorAll('div')].filter((n) => String(n.getAttribute('class') || '').includes('w-[50%]'));
      return JSON.stringify({ halves: halves.length, stillHasPath: /out\\/ui-note\\.txt/.test(d.innerText) });
    } catch (e) {
      return JSON.stringify({ halves: 0, stillHasPath: false, note: String(e) });
    }
  })()`));
  if (!S.halves) {
    const errs = await cdp.evaluate(`JSON.stringify(window.__errs ?? [])`);
    const body = await cdp.evaluate(`document.body.innerText.replace(/\\s+/g,' ').slice(0, 120)`);
    console.log(`    ↳ 页面报错：${errs}`);
    console.log(`    ↳ 当前正文：${body}`);
  }
  ok(S.halves >= 2, `并排视图渲染成左右两栏（实际 ${S.halves} 个半栏）`, S.note ?? '');
  ok(S.stillHasPath, '切换视图后文件头还在');

  await cdp.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  await sleep(400);

  /* 把界面还原成"开着长会话"：后面的排队条用例默认界面就在 s1 上，
     这一段刷新过页面又切走了会话，不还原会让后面全挂（踩过）。 */
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(5200);
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-region="sessions"] div')]
      .find((r) => r.className.includes('cursor-pointer') && r.textContent.includes('长会话'));
    row?.click();
    return Boolean(row);
  })()`);
  await sleep(1500);
}

console.log('\n【上下文环】');
/* 需求：上下文占用常驻顶栏、真分词计数、悬停给分解 */
{
  const C = JSON.parse(await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('header *')].find((n) => /上下文占用/.test(n.getAttribute('title') || ''));
    return JSON.stringify({ has: Boolean(el), title: el?.getAttribute('title') || '' });
  })()`));
  ok(C.has, '顶栏有上下文占用环（真分词计数）');
  ok(/真分词计数/.test(C.title), `环的说明写明计数口径（实际：${C.title.slice(0, 40)}）`);
}

console.log('\n【附件顺序】');
// 需求：图片/视频要按模型发出的顺序插在正文里，而不是一律堆在末尾
const ordered = await cdp.evaluate(`(() => {
  const msg = [...document.querySelectorAll('[data-region="messages"] .chat-col > div')].find((d) => d.querySelector('figure'));
  if (!msg) return JSON.stringify({ error: '找不到带附件的消息' });
  const out = [];
  const walk = (node) => {
    for (const el of node.children) {
      if (el.matches('figure')) { out.push(el.querySelector('img') ? 'IMAGE' : 'VIDEO'); continue; }
      if (el.matches('.md')) { const t = (el.innerText || '').replace(/\s+/g, '').trim(); if (t) out.push('text:' + t); continue; }
      walk(el);
    }
  };
  walk(msg);
  return JSON.stringify({ out });
})()`);
const O = JSON.parse(ordered);
ok(
  !O.error && JSON.stringify(O.out) === JSON.stringify(['text:第一句话。', 'IMAGE', 'text:第二句话。', 'IMAGE']),
  `正文与附件按模型发出的顺序交替（实际 ${JSON.stringify(O.out ?? O.error)}）`,
);

console.log('\n【排队条（运行中发消息 = 先排队，不进消息区）】');
{
  // 起一段慢运行（服务端跑，界面只是观察者）
  // 慢运行必须起在**界面正开着的那条会话**上（s1）——否则界面开着 A、运行在 B，排队条不会出现
  const chat = await api('POST', '/api/chat', { sessionId: s1, text: '慢任务：请慢慢回答' });
  await sleep(1500); // 等它进入运行态（界面收到 run_started）
  const runId = chat.json.runId;

  // 在输入框里真的打字 + 回车
  await cdp.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.value = '排队的一句补充'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(200);
  await cdp.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await sleep(1200);

  const strip = await cdp.evaluate(`(() => { try {
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    const hasStrip = /队列 1 条/.test(text);
    const inMessages = document.querySelector('[data-region="messages"]').innerText.includes('排队的一句补充');
    const hasExecute = [...document.querySelectorAll('button')].some((b) => b.textContent.includes('立即执行'));
    const hasDelete = [...document.querySelectorAll('button')].some((b) => (b.title || '').includes('从队列里删掉'));
    const mode = [...document.querySelectorAll('span')].some((s) => s.textContent === '排队');
    return JSON.stringify({ hasStrip, inMessages, hasExecute, hasDelete, mode });
  } catch (e) { return JSON.stringify({ error: String(e) }); } })()`);
  const S = JSON.parse(strip);
  ok(S.hasStrip, '输入框上方出现「队列 1 条」');
  ok(!S.inMessages, '**排队中的消息不出现在消息区**（没执行就不显示）');
  ok(S.hasExecute, '队列条里有「立即执行」按钮');
  ok(S.hasDelete, '队列条里有删除按钮');
  ok(S.mode, 'Enter 默认语义是「排队」（这一段跑完自动执行）');

  // 点删除 → 排队条消失（且服务端队列也空）
  const del = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').includes('从队列里删掉'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1000);
  const after = await cdp.evaluate(`(() => {
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    return JSON.stringify({ stillThere: /队列 1 条/.test(text) });
  })()`);
  ok(del && !JSON.parse(after).stillThere, '点删除后排队条消失');
  const q = await api('GET', `/api/run/queue?sessionId=${chat.json.sessionId}`);
  ok((q.json.items ?? []).length === 0, '服务端队列也空了');

  // 别的设备/标签页排的队，这边也要能看到（服务端广播 queued 事件 + 会话详情带队列）
  const fromElsewhere = await api('POST', '/api/chat', { sessionId: chat.json.sessionId, text: '别的设备排的队' });
  ok(fromElsewhere.json.steered === true, '经接口入队成功');
  await sleep(1200);
  const seen = await cdp.evaluate(`document.body.innerText.includes('别的设备排的队') && /队列 1 条/.test(document.body.innerText.replace(/\\s+/g, ' '))`);
  ok(seen, '别的设备排的队也会出现在排队条里（不是只有自己发的才显示）');
  await api('POST', '/api/run/queue', { sessionId: chat.json.sessionId, id: fromElsewhere.json.item.id, action: 'remove' });

  // 停掉这段运行，免得它一直在跑（后面没有别的检查依赖它）
  await api('POST', '/api/run/stop', { runId });
  await sleep(500);
}

console.log('\n【侧栏交互】');
const sidebar = await cdp.evaluate(`(async () => {
  const side = document.querySelector('aside');
  const hasSelect = Boolean(side.querySelector('select'));
  const accountRow = side.textContent.includes('leo') && Boolean([...side.querySelectorAll('button')].find(b => b.textContent.includes('退出')));
  // 点「+」应弹出项目清单
  const plus = [...side.querySelectorAll('button')].find(b => b.title && b.title.includes('新建会话'));
  plus.click();
  await new Promise(r => setTimeout(r, 300));
  const picker = [...document.querySelectorAll('div')].find(d => d.textContent.includes('在哪个项目下新建会话'));
  return JSON.stringify({ hasSelect, accountRow, pickerOpened: Boolean(picker) });
})()`);
const SB = JSON.parse(sidebar);
ok(!SB.hasSelect, '侧栏里没有项目选择器（已挪到「+」菜单）');
ok(!SB.accountRow, '侧栏左下没有账号/退出行');
ok(SB.pickerOpened, '点「+」弹出「在哪个项目下新建会话」');

// 关掉 + 菜单：它的遮罩是 fixed inset-0，不关掉会挡住后面所有鼠标事件
await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('aside button')].find(x => x.title && x.title.includes('新建会话')); b?.click(); return true; })()`);
await sleep(400);
const hover = await cdp.evaluate(`(() => {
  const row = [...document.querySelectorAll('[data-region="sessions"] div')].find(r => r.className.includes('cursor-pointer') && r.textContent.includes('长会话'));
  if (!row) return JSON.stringify({ error: 'no-row' });
  const r = row.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.right - 30), y: Math.round(r.top + r.height / 2) });
})()`);
const H = JSON.parse(hover);
if (!H.error) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: H.x, y: H.y, buttons: 0 });
  await sleep(700);
  const btns = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-region="sessions"] div')].find(r => r.className.includes('cursor-pointer') && r.textContent.includes('长会话'));
    return JSON.stringify([...row.querySelectorAll('button')].map(b => ({ t: b.title, v: b.offsetParent !== null })));
  })()`);
  const B = JSON.parse(btns);
  ok(B.some((b) => b.t.includes('置顶') && b.v), '会话行悬停出现「置顶」');
  ok(B.some((b) => b.t.includes('归档') && b.v), '会话行悬停出现「归档」');
} else {
  ok(false, '找到会话行', H.error);
}

console.log('\n【归档】');
const archived = await api('GET', '/api/archive');
ok(archived.json.sessions.some((s) => s.id === s3), '归档接口里有刚归档的会话');
const guarded = await api('DELETE', `/api/session/${s2}`);
ok(guarded.status === 409, '没归档的会话不能直接彻底删除（409）');
await api('POST', `/api/session/${s3}/archive`, { archived: false });
const back = await api('GET', '/api/sessions');
ok(back.json.sessions.some((s) => s.id === s3), '恢复后回到活跃列表');
const pinnedFirst = back.json.sessions[0];
ok(pinnedFirst.pinned === true, '置顶会话排在最前');

console.log('\n【归档整个项目（用户报过的 bug：归档后侧栏变成显示已归档的会话）】');
{
  // 悬停项目分组标题 → 点它的「归档项目」
  const head = await cdp.evaluate(`(() => {
    const h = [...document.querySelectorAll('[data-region="sessions"] div.group')].find((d) => d.textContent.includes('界面检查项目'));
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) });
  })()`);
  if (!head) {
    ok(false, '找到项目分组标题');
  } else {
    const { x, y } = JSON.parse(head);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(500);
    const btn = await cdp.evaluate(`(() => {
      const h = [...document.querySelectorAll('[data-region="sessions"] div.group')].find((d) => d.textContent.includes('界面检查项目'));
      const b = [...h.querySelectorAll('button')].find((x) => (x.title || '').includes('归档项目'));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    if (!btn) {
      ok(false, '悬停后出现「归档项目」按钮');
    } else {
      const b = JSON.parse(btn);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, buttons: 0 });
      await sleep(200);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await sleep(1500);

      const after = await cdp.evaluate(`(() => {
        const nav = document.querySelector('[data-region="sessions"]');
        const text = nav.innerText.replace(/\s+/g, ' ');
        return JSON.stringify({ text, hasLong: text.includes('长会话'), hasOther: text.includes('未归属项目') });
      })()`);
      const A = JSON.parse(after);
      ok(!A.hasLong, `归档项目后侧栏不再显示它的会话（实际：${A.text.slice(0, 60)}）`);
      ok(A.hasOther, '别的会话还在（没被连带）');
      // 刷新后应当与刚才一致（用户报的正是"刷新才恢复"——两边必须一样）
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      await sleep(5000);
      const reloaded = await cdp.evaluate(`document.querySelector('[data-region="sessions"]').innerText.replace(/\s+/g, ' ')`);
      ok(!reloaded.includes('长会话'), '刷新后一致（不再出现"归档后与刷新后不一样"）');
    }
  }
}

/* ────────────────────────── 设置：模型 vs 系统 两页 ────────────────────────── */

console.log('\n【设置：模型 / 系统 两页（参数归属归一，且都在界面上可改）】');
{
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(5000);

  // 打开设置抽屉，切到「系统」
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '设置');
    if (b) b.click();
    return true;
  })()`);
  await sleep(800);
  const sys = await cdp.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '系统');
    if (!btn) return JSON.stringify({ error: '没有「系统」板块入口' });
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    const inputs = [...document.querySelectorAll('input[type="number"]')].length;
    const has = (s) => text.includes(s);
    return JSON.stringify({
      inputs,
      hasMaxRounds: has('maxRounds'),
      hasMaxRuns: has('maxRuns'),
      hasSpill: has('spillMaxChars'),
      hasCheckpoint: has('checkpointLimit'),
      hasQueueDefault: has('queueDefault') || has('默认语义'),
    });
  })()`);
  const Y = JSON.parse(sys);
  ok(!Y.error, `「系统」板块能打开（${Y.error ?? 'ok'}）`);
  if (!Y.error) {
    ok(Y.inputs >= 6, `系统参数以可编辑输入框呈现（${Y.inputs} 个数字输入框）`);
    ok(Y.hasMaxRounds && Y.hasMaxRuns, '轮次上限 / 并发上限在系统页可见可改');
    ok(Y.hasSpill, '超长结果落盘阈值在系统页可见可改');
    ok(Y.hasCheckpoint, '检查点列表条数（此前硬编码 200）在系统页可见可改');
    ok(Y.hasQueueDefault, '运行中发消息的默认语义在系统页可见可改');
  }

  // 切到「模型」：应当**只**有模型调用参数，不再混着系统参数
  const models = await cdp.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '模型');
    if (!btn) return JSON.stringify({ error: '没有「模型」板块入口' });
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    return JSON.stringify({
      hasTemp: text.includes('temperature'),
      hasMaxRounds: text.includes('maxRounds'),
      hasSpill: text.includes('spillMaxChars'),
      hasCtx: text.includes('ctxLimit'),
    });
  })()`);
  const M = JSON.parse(models);
  ok(!M.error, `「模型」板块能打开（${M.error ?? 'ok'}）`);
  if (!M.error) {
    ok(M.hasTemp && M.hasCtx, '模型页有模型调用参数（temperature / ctxLimit）');
    ok(!M.hasMaxRounds && !M.hasSpill, '模型页不再混入系统参数（轮次/spill 已挪到系统页）');
  }

  // 关掉抽屉
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '关闭');
    if (b) b.click();
    return true;
  })()`);
  await sleep(400);
}

/* ────────────────────────── 手机（<md）布局 ──────────────────────────
   需求：手机上顶栏**只有两个按键** —— 左＝会话抽屉、右＝设置抽屉；其余信息（模型状态、
   项目名、上下文环、实时状态）与面板入口（待办/日志）一律不显示，一切以手机好用为准。
   这一段把窗口改成 390×844 真跑一遍：位置/宽度/开合/互斥/隐藏全部量出来。
   量之前先关掉桌面那段遗留在状态里的抽屉与遮罩（settings 抽屉仍可能开着）。 */
console.log('\n【手机布局】');
{
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(5200);

  const M = JSON.parse(await cdp.evaluate(`(() => {
    const hdr = document.querySelector('header');
    const vis = (el) => Boolean(el && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    const btns = [...hdr.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: (b.textContent || b.getAttribute('aria-label') || '').trim(), title: b.getAttribute('title') || '', vis: vis(b), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const left = document.querySelector('[aria-label="会话列表"]');
    const right = document.querySelector('[aria-label="设置"]');
    const lr = left?.getBoundingClientRect();
    const rr = right?.getBoundingClientRect();
    const rightCol = document.querySelector('[aria-label="右列"]');
    return JSON.stringify({
      headerH: Math.round(hdr.getBoundingClientRect().height),
      vw: window.innerWidth,
      visible: btns.filter((b) => b.vis).map((b) => b.label),
      sizes: btns.filter((b) => b.vis).map((b) => b.w + 'x' + b.h),
      leftAtLeftEdge: Boolean(lr) && lr.x < 40,
      rightAtRightEdge: Boolean(rr) && rr.right > window.innerWidth - 40,
      rightColShown: Boolean(rightCol && vis(rightCol)),
      titleStill: vis(document.querySelector('header span.min-w-0')),
      docScroll: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
      truncated: [document.documentElement.scrollWidth, document.body.scrollWidth],
    });
  })()`));
  ok(M.headerH === 56, `手机顶栏仍是 h-14（${M.headerH}px）`);
  ok(M.visible.length === 2, `顶栏只剩 2 个按键（实际 ${M.visible.length} 个：${M.visible.join(' / ')}）`);
  ok(M.visible.join('|') === '会话列表|设置', `两个按键是「会话列表」与「设置」（实际：${M.visible.join(' / ')}）`);
  ok(M.leftAtLeftEdge && M.rightAtRightEdge, '会话键在左、设置键在右（贴住两侧）');
  ok(M.sizes.every((s) => s.split('x').every((n) => Number(n) >= 40)), `手指点得中（每个 ${M.sizes.join('、')}）`);
  ok(!M.rightColShown, '手机不占位右列（待办/文件改动列整列隐藏）');
  ok(M.titleStill, '顶栏还留着会话标题（只留标题这一条即时信息）');
  ok(M.docScroll <= 1 && M.truncated.every((w) => w <= M.vw + 1), `不出现横向滚动或整页滚动（doc ${M.docScroll}px，宽 ${M.truncated.join('/')} vs ${M.vw}）`);

  // 左键 → 会话抽屉（86vw 宽、从左边滑出、带遮罩）
  await cdp.evaluate(`(() => { document.querySelector('[aria-label="会话列表"]').click(); return true; })()`);
  await sleep(700);
  const S = JSON.parse(await cdp.evaluate(`(() => {
    const side = document.querySelector('aside');
    const r = side.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x), w: Math.round(r.width), vw: window.innerWidth, attr: document.documentElement.dataset.drawer || '' });
  })()`));
  ok(S.x === 0 && S.w > 0, `点会话键打开左侧抽屉（x=${S.x}，宽 ${S.w}px）`);
  ok(S.w / S.vw > 0.75 && S.w / S.vw < 0.95, `抽屉留一条边能看到消息区（${S.w}/${S.vw}）`);
  ok(S.attr === 'sessions', '抽屉开合状态写在 <html data-drawer> 上（便于互斥与检查）');

  // 点遮罩关掉；再开设置抽屉（占满整屏、靠右、顶部有行内「关闭」）
  await cdp.evaluate(`(() => { const m = [...document.querySelectorAll('div')].find(d => { const c = String(d.className || ''); return c.includes('fixed') && c.includes('inset-0') && c.includes('bg-black/50') && c.includes('md:hidden'); }); m?.click(); return Boolean(m); })()`);
  await sleep(500);
  await cdp.evaluate(`(() => { document.querySelector('[aria-label="设置"]').click(); return true; })()`);
  await sleep(900);
  const D = JSON.parse(await cdp.evaluate(`(() => {
    const all = [...document.querySelectorAll('div')].map((d) => String(d.className || ''));
    const drawer = [...document.querySelectorAll('div')].find((d) => String(d.className || '').includes('fixed inset-0 z-50'));
    const r = drawer?.getBoundingClientRect();
    const close = [...drawer.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭');
    const ca = close?.getBoundingClientRect();
    const tabs = [...drawer.querySelectorAll('button[data-section]')].map((b) => ({ n: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) }));
    return JSON.stringify({
      open: Boolean(drawer),
      x: r ? Math.round(r.x) : -1,
      w: r ? Math.round(r.width) : 0,
      vw: window.innerWidth,
      hasClose: Boolean(close),
      closeTouch: ca ? Math.round(ca.height) : 0,
      tabs: tabs.length,
      tabMinH: tabs.length ? Math.min(...tabs.map((t) => t.h)) : 0,
      attr: document.documentElement.dataset.drawer || '',
    });
  })()`));
  ok(D.open, '点设置键打开设置抽屉');
  ok(D.w / D.vw > 0.9 && D.x >= 0, `手机上设置抽屉占满整屏（${D.w}/${D.vw}）`);
  ok(D.hasClose && D.closeTouch >= 36, `顶部有行内「关闭」（高 ${D.closeTouch}px，够点）`);
  ok(D.tabs >= 10 && D.tabMinH >= 40, `十个板块页签都够大（${D.tabs} 个，最小高 ${D.tabMinH}px）`);
  ok(D.attr === 'settings', '设置抽屉开着时 data-drawer=settings');

  // 互斥：设置抽屉开着时点会话键 → 设置收起、会话抽屉出来
  await cdp.evaluate(`(() => { document.querySelector('[aria-label="会话列表"]').click(); return true; })()`);
  await sleep(700);
  const X = JSON.parse(await cdp.evaluate(`(() => {
    const side = document.querySelector('aside');
    const sr = side.getBoundingClientRect();
    const drawer = [...document.querySelectorAll('div')].find((d) => String(d.className || '').includes('fixed inset-0 z-50'));
    return JSON.stringify({ sideX: Math.round(sr.x), drawerOpen: Boolean(drawer), attr: document.documentElement.dataset.drawer || '' });
  })()`));
  ok(X.sideX === 0 && X.attr === 'sessions', '开会话抽屉时设置抽屉自动收起（两个抽屉不同时出现）');
  ok(!X.drawerOpen, '设置抽屉确实不在了');

  // 收尾：关掉侧栏遮罩，恢复桌面视口
  await cdp.evaluate(`(() => { const m = [...document.querySelectorAll('div')].find(d => { const c = String(d.className || ''); return c.includes('fixed') && c.includes('inset-0') && c.includes('bg-black/50') && c.includes('md:hidden'); }); m?.click(); return true; })()`);
  await sleep(400);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const back = JSON.parse(await cdp.evaluate(`(() => {
    const side = document.querySelector('aside');
    const hdr = document.querySelector('header');
    const vis = (el) => Boolean(el && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    return JSON.stringify({
      sideVisible: vis(side),
      btns: [...hdr.querySelectorAll('button')].filter(vis).length,
      rightCol: vis(document.querySelector('[aria-label="右列"]')),
      sideX: Math.round(side.getBoundingClientRect().x),
    });
  })()`));
  ok(back.sideVisible && back.sideX === 0, '回到宽屏：会话列照旧常驻（没有被手机样式带歪）');
  ok(back.btns > 2, `宽屏顶栏恢复全部按键（${back.btns} 个）`);
  ok(back.rightCol, '宽屏右列（待办）照旧占位');
}

/* ────────────────────────── 收尾 ────────────────────────── */

await cdp.send('Page.navigate', { url: 'about:blank' }); // 别留着开着 SSE 的窗口
cdp.close();
try {
  upstream?.closeAllConnections();
  upstream?.close();
} catch {
  /* 忽略 */
}
cleanup();

console.log(`\n结果：${pass} 项通过 / ${fail} 项失败`);
process.exit(fail ? 1 : 0);
