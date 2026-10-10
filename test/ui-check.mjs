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
   60s 的窗口 —— 检查脚本的步骤多，窗口太短会偶发。 */
upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
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

  const strip = await cdp.evaluate(`(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ');
    const hasStrip = /排队 1 条/.test(text);
    const inMessages = document.querySelector('[data-region="messages"]').innerText.includes('排队的一句补充');
    const hasExecute = [...document.querySelectorAll('button')].some((b) => b.textContent.includes('立即执行'));
    const hasDelete = [...document.querySelectorAll('button')].some((b) => (b.title || '').includes('从队列里删掉'));
    return JSON.stringify({ hasStrip, inMessages, hasExecute, hasDelete });
  })()`);
  const S = JSON.parse(strip);
  ok(S.hasStrip, '输入框上方出现「排队 1 条」');
  ok(!S.inMessages, '**排队中的消息不出现在消息区**（没执行就不显示）');
  ok(S.hasExecute, '排队条里有「立即执行」按钮');
  ok(S.hasDelete, '排队条里有删除按钮');

  // 点删除 → 排队条消失（且服务端队列也空）
  const del = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').includes('从队列里删掉'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1000);
  const after = await cdp.evaluate(`(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ');
    return JSON.stringify({ stillThere: /排队 1 条/.test(text) });
  })()`);
  ok(del && !JSON.parse(after).stillThere, '点删除后排队条消失');
  const q = await api('GET', `/api/run/queue?sessionId=${chat.json.sessionId}`);
  ok((q.json.items ?? []).length === 0, '服务端队列也空了');

  // 别的设备/标签页排的队，这边也要能看到（服务端广播 queued 事件 + 会话详情带队列）
  const fromElsewhere = await api('POST', '/api/chat', { sessionId: chat.json.sessionId, text: '别的设备排的队' });
  ok(fromElsewhere.json.steered === true, '经接口入队成功');
  await sleep(1200);
  const seen = await cdp.evaluate(`document.body.innerText.includes('别的设备排的队') && /排队 1 条/.test(document.body.innerText.replace(/\\s+/g, ' '))`);
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
