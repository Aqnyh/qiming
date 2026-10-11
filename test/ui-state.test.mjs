/**
 * test/ui-state.test.mjs —— 前端状态层的确定性回归测试（不起浏览器）。
 *
 * 为什么需要它：界面状态层的 bug 多半是**竞态**，靠肉眼看或跑一次都不一定复现
 * （比如"发送后显示两条、刷新后一条"——取决于 SSE 事件与 POST 响应谁先到）。
 * 这里用桩把两条通道的**到达顺序**钉死，于是竞态变成可重复的用例。
 *
 * 姿势：`ui/state/*.js` 是纯 JS（没有 JSX），Node 里能直接 import；
 * 只需要先补上它用到的浏览器全局（localStorage / EventSource / matchMedia / fetch）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/* ────────────────────────── 浏览器全局的桩 ────────────────────────── */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) };

class FakeEventSource {
  constructor(url) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {}
}
globalThis.EventSource = FakeEventSource;

/** fetch 桩：路由表 + 可手动放行的"迟到响应" */
const routes = new Map();
let pendingRelease = null;
globalThis.fetch = async (url, opts = {}) => {
  const key = `${opts.method ?? 'GET'} ${url}`;
  const handler = routes.get(key) ?? routes.get(url);
  if (!handler) throw new Error(`测试没准备这条路由：${key}`);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  const out = await handler(body, opts);
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  return { ok: true, status: 200, text: async () => text };
};

let session;
let appState;

before(async () => {
  session = await import('../ui/state/session.js');
  ({ state: appState } = await import('../ui/state/store.js'));
  routes.set('/api/chat', async (body) => {
    // 关键：**先**把服务端的 msg 事件派发出去（模拟服务端"先广播、后回响应"），再放行响应
    if (pendingRelease) await pendingRelease();
    return { ok: true, runId: 'r1', sessionId: body.sessionId ?? 's1' };
  });
});

/* ────────────────────────── 用例 ────────────────────────── */

test('消息分段：附件按 contentAt 插到正文的对应位置（模型发出的顺序）', async () => {
  const { buildParts, visibleMessages } = await import('../ui/lib/message-parts.js');
  const media = (id) => ({ seq: id, media: [{ kind: 'image', url: `https://x/${id}.png` }] });

  // 没有附件的调用不参与切段（它们只在折叠的追踪条里）
  const plain = buildParts('只有正文', [{ seq: 1, name: 'read_file' }]);
  assert.deepEqual(plain, [{ text: '只有正文', calls: [] }]);

  // "先说一句 → 发图 → 再说一句 → 再发视频"：两段正文各带自己的卡
  const text = '先看这张图。再看这段视频。';
  const at1 = '先看这张图。'.length;
  const parts2 = buildParts(text, [
    { seq: 1, contentAt: at1, media: [{ kind: 'image', url: 'https://x/1.png' }] },
    { seq: 2, contentAt: text.length, media: [{ kind: 'video', url: 'https://x/2.mp4' }] },
  ]);
  assert.deepEqual(parts2.map((p) => p.text), ['先看这张图。', '再看这段视频。', '']);
  assert.equal(parts2[0].calls[0].seq, 1);
  assert.equal(parts2[1].calls[0].seq, 2);
  assert.equal(parts2[2].calls.length, 0);

  // 老记录（没有 contentAt）：夹到末尾 = 卡片跟在整段正文之后，保持旧观感
  const legacy = buildParts('正文', [{ seq: 9, files: ['/tmp/downloads/a.txt'] }]);
  assert.deepEqual(legacy.map((p) => p.text), ['正文', '']);
  assert.equal(legacy[0].calls[0].seq, 9, '卡片挂在"这段正文之后"');
  assert.equal(legacy[1].calls.length, 0);

  /* 插话**不进消息区**（用户明确要求）：它由循环注入的浅文字提示呈现（助手消息的 notices）。
     这条用例守住"插话永远不出现在消息区"这个约定 —— 它曾经被拼成气泡，
     还一度被按位置插进正文中间（那正是"顺序看起来不对"的根源）。 */
  const mixed = [
    { id: 'u1', role: 'user', content: '问题' },
    { id: 'a1', role: 'assistant', content: '答一' },
    { id: 's1', role: 'user', content: '插话', steer: true },
    { id: 'a2', role: 'assistant', content: '答二' },
  ];
  assert.deepEqual(visibleMessages(mixed).map((m) => m.id), ['u1', 'a1', 'a2'], '插话被滤掉，其余顺序不变');
  assert.deepEqual(visibleMessages(null), []);
  // 插话仍完整留在会话数据里（模型看得到、审计追得到），只是不渲染
  assert.equal(mixed.filter((m) => m.steer).length, 1);

  // 越界/负数要夹到合法范围，不能切飞
  const clamped = buildParts('abc', [{ seq: 1, contentAt: 999, media: [{}] }, { seq: 2, contentAt: -5, media: [{}] }]);
  assert.deepEqual(clamped.map((p) => p.text), ['', 'abc', '']);
});

test('diff 行装配：折叠只留头尾、并排按块配对、展开按 from 摊平', async () => {
  const { unifiedRows, splitRows, splitRowsWithFolds, CONTEXT } = await import('../ui/lib/diff-rows.js');
  assert.equal(CONTEXT, 3, '折叠保留行数写死在协议里（与 git --unified=3 对齐）');

  const ctx = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ oldNo: from + i, newNo: from + i, kind: 'ctx', text: `第${from + i}行` }));
  const add = (t) => ({ oldNo: null, newNo: null, kind: 'add', text: t });
  const del = (t) => ({ oldNo: null, newNo: null, kind: 'del', text: t });

  /* 中间一段长上下文：折起来，头尾各留 3 行（GitHub 那个「展开 N 行」条） */
  const mid = unifiedRows([...ctx(2, 1), add('新'), ...ctx(10, 10)]);
  const fold = mid.find((r) => r.type === 'fold');
  assert.ok(fold, '中间的长上下文要折起来');
  assert.equal(fold.count, 10 - CONTEXT, '折叠数 = 该段总长 − 保留的头尾');
  assert.equal(mid.filter((r) => r.type === 'line' && r.line.kind === 'ctx').length, 2 + CONTEXT, '头尾保留数正确');

  /* 首尾的上下文段：**靠文件那头不留行**（上面/下面没有内容，留了也只是白占地方），
     但**照样要折** —— 它挨着改动的那一侧仍然可以展开。 */
  const edges = unifiedRows([...ctx(8, 1), add('x'), ...ctx(8, 20)]);
  const folds = edges.filter((r) => r.type === 'fold');
  assert.equal(folds.length, 2, '开头与结尾的上下文段各自成条');
  assert.equal(folds[0].count, 8 - CONTEXT, '开头段只留尾 3 行（上面没内容，不留头）');
  assert.equal(folds[1].count, 8 - CONTEXT, '结尾段只留头 3 行（下面没内容，不留尾）');
  assert.equal(edges.filter((r) => r.type === 'line').length, 1 + CONTEXT * 2, '加上那 1 行改动');

  /* expandAll：一条折叠都不产生 */
  assert.equal(unifiedRows([...ctx(2, 1), add('新'), ...ctx(10, 10)], { expandAll: true }).length, 13);

  /* 并排：删 3 加 2 是**同一处改动**，配成 3 行（落单的左边留 null），不是错开成 5 行 */
  const pairs = splitRows([del('a'), del('b'), del('c'), add('A'), add('B')]);
  assert.equal(pairs.length, 3, '按块配对，不是按索引');
  assert.deepEqual(pairs.map((p) => p.left?.text ?? null), ['a', 'b', 'c']);
  assert.deepEqual(pairs.map((p) => p.right?.text ?? null), ['A', 'B', null]);

  /* 上下文行两边共用同一条（同一个对象，渲染时左右各画一次） */
  const withCtx = splitRows([...ctx(1, 1), add('z')]);
  assert.equal(withCtx[0].left, withCtx[0].right, '上下文行左右是同一行');

  /* 并排 + 折叠：折叠条出现在与统一视图**相同的位置**；opened 里的段就地摊平 */
  const lines = [...ctx(2, 1), add('新'), ...ctx(10, 10)];
  const sf = splitRowsWithFolds(lines);
  assert.equal(sf.filter((r) => r.fold).length, 1, '并排视图也要有折叠条');
  const f0 = sf.find((r) => r.fold).fold;
  assert.equal(f0.to - f0.from, f0.count, 'from/to 圈住的就是被藏起来的那段（展开时正好补 count 行）');
  const opened = splitRowsWithFolds(lines, { opened: new Set([f0.from]) });
  assert.equal(opened.filter((r) => r.fold).length, 0, '展开过的段不再折叠');
  assert.equal(opened.length, lines.length, '摊平后行数与原文一致（不多不少，不重复头尾）');

  /* 统一视图的展开同理：补上的行数必须等于按钮上写的 count */
  const uni = unifiedRows(lines);
  const uf = uni.find((r) => r.type === 'fold');
  const expanded = [...uni.filter((r) => r.type === 'line').map((r) => r.line), ...lines.slice(uf.from, uf.to)];
  assert.equal(lines.slice(uf.from, uf.to).length, uf.count, '展开补的行数 = count');
  assert.deepEqual(expanded, lines, '展开后应还原成完整的逐行序列');

  /* 空输入不能炸（服务端返回空 diff 是常态） */
  assert.deepEqual(unifiedRows([]), []);
  assert.deepEqual(splitRows(null), []);
  assert.deepEqual(splitRowsWithFolds(undefined), []);
});

test('发送消息：SSE 的 msg 事件先到时，不会重复插一条本地乐观消息', async () => {
  appState.activeId = 's1';
  appState.msgsFor = 's1';
  appState.msgs = [];

  // 让 POST 响应"迟到"，在迟到期间派发服务端的用户消息事件（这就是真实竞态的顺序）
  let release;
  pendingRelease = () => new Promise((r) => (release = r));
  const sending = session.send('你好，这是一条测试消息');

  await new Promise((r) => setTimeout(r, 0)); // 让 send() 走到 await
  session.applyEvent({
    type: 'msg',
    runId: 'r1',
    sessionId: 's1',
    msg: { id: 'm_server', role: 'user', content: '你好，这是一条测试消息', ts: Date.now() },
  });
  assert.equal(appState.msgs.filter((m) => m.role === 'user').length, 1, '事件先到：列表里应只有服务端那条');

  release();
  await sending;
  pendingRelease = null;

  const users = appState.msgs.filter((m) => m.role === 'user');
  assert.equal(users.length, 1, `不该出现两条用户消息（实际 ${users.length} 条）`);
  assert.equal(users[0].id, 'm_server', '留下的应是服务端那条（刷新后也是它）');
});

test('发送消息：响应先到（事件还没来）时，仍然插一条本地乐观消息，事件到达后换成正身', async () => {
  appState.activeId = 's2';
  appState.msgsFor = 's2';
  appState.msgs = [];
  pendingRelease = null;

  await session.send('第二条测试消息');
  let users = appState.msgs.filter((m) => m.role === 'user');
  assert.equal(users.length, 1, '响应先到：本地乐观条立刻可见');
  assert.equal(users[0].local, true);

  session.applyEvent({
    type: 'msg',
    runId: 'r1',
    sessionId: 's2',
    msg: { id: 'm_server2', role: 'user', content: '第二条测试消息', ts: Date.now() },
  });
  users = appState.msgs.filter((m) => m.role === 'user');
  assert.equal(users.length, 1, '事件到达后本地条被换成正身，不该多出一条');
  assert.equal(users[0].id, 'm_server2');
  assert.equal(users[0].local, false);
});

test('插话：本地条与服务端落定的那条也只留一条', async () => {
  appState.activeId = 's3';
  appState.msgsFor = 's3';
  appState.msgs = [{ id: 'm_a', role: 'assistant', content: '在跑', ts: Date.now() }];
  appState.runs = { s3: { runId: 'r1', startedAt: Date.now(), status: 'running' } };

  let release;
  pendingRelease = () => new Promise((r) => (release = r));
  routes.set('/api/chat', async (body) => {
    if (pendingRelease) await pendingRelease();
    return { ok: true, runId: 'r1', sessionId: body.sessionId, steered: true, mode: 'steer' };
  });
  const sending = session.send('插一句话', 'steer');
  await new Promise((r) => setTimeout(r, 0));
  // 服务端把插话落成会话消息（steer: true）并广播
  session.applyEvent({
    type: 'msg',
    runId: 'r1',
    sessionId: 's3',
    msg: { id: 'm_steer', role: 'user', content: '插一句话', ts: Date.now(), steer: true },
  });
  release();
  await sending;
  pendingRelease = null;

  const steers = appState.msgs.filter((m) => m.steer);
  assert.equal(steers.length, 1, `插话只该显示一条（实际 ${steers.length} 条）`);
  assert.equal(steers[0].id, 'm_steer');
});
