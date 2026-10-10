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
  const { buildParts } = await import('../ui/lib/message-parts.js');
  const media = (id) => ({ seq: id, media: [{ kind: 'image', url: `https://x/${id}.png` }] });

  // 没有附件的调用不参与切段（它们只在折叠的追踪条里）
  const plain = buildParts('只有正文', [{ seq: 1, name: 'read_file' }]);
  assert.deepEqual(plain, [{ text: '只有正文', calls: [], steers: [] }]);

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

  /* 插话（立即执行）按 steerAt 切段：它必须夹在正文中间，不能堆到消息末尾。
     用户报的就是"插话跑到最下面、所有模型输出都在它上面"。 */
  const t2 = '第一段话。第二段话。';
  const steered = buildParts(
    t2,
    [{ seq: 1, contentAt: t2.length, media: [{ kind: 'image', url: 'https://x/3.png' }] }],
    [{ id: 's1', content: '插话', steer: true, steerAt: '第一段话。'.length }],
  );
  assert.deepEqual(steered.map((p) => p.text), ['第一段话。', '第二段话。', '']);
  assert.equal(steered[0].steers[0].id, 's1', '插话落在"第一段话"之后 —— 正是它被打断的位置');
  assert.equal(steered[0].calls.length, 0);
  assert.equal(steered[1].calls[0].seq, 1, '同一位置的卡片排在插话之后（先看到自己插的话，再看到产出）');
  assert.equal(steered[2].text, '');

  /* 老插话没有 steerAt：按"放在开头"处理（等价于打断后重开一段），也不能丢 */
  const legacySteer = buildParts('正文', [], [{ id: 's2', content: '旧插话', steer: true }]);
  assert.equal(legacySteer[0].steers[0].id, 's2');

  /* groupSteers：插话归到它插进的那条助手消息上（不靠数组里谁挨着谁） */
  const { groupSteers } = await import('../ui/lib/message-parts.js');
  const msgs = [
    { id: 'u1', role: 'user', content: '问题' },
    { id: 'a1', role: 'assistant', content: '答一' },
    { id: 's1', role: 'user', content: '插话', steer: true, steerInto: 'a1', steerAt: 0 },
    { id: 'a2', role: 'assistant', content: '答二' },
    { id: 's0', role: 'user', content: '更早的插话', steer: true }, // 老数据：靠"后面那条助手"兜底
    { id: 'a3', role: 'assistant', content: '答三' },
  ];
  const g = groupSteers(msgs);
  assert.deepEqual([...g.byHost.keys()].sort(), ['a1', 'a3']);
  assert.equal(g.byHost.get('a1')[0].id, 's1');
  assert.equal(g.byHost.get('a3')[0].id, 's0', '没有 steerInto 时，归给后面那条助手消息');
  assert.deepEqual(g.rest.map((m) => m.id), ['u1', 'a1', 'a2', 'a3']);
  assert.equal(g.orphans.length, 0);

  // 完全无从归属的插话不能丢：落进 orphans，界面照样显示
  const orphan = groupSteers([{ id: 's9', role: 'user', content: '孤儿', steer: true }]);
  assert.deepEqual(orphan.orphans.map((m) => m.id), ['s9']);

  // 越界/负数要夹到合法范围，不能切飞
  const clamped = buildParts('abc', [{ seq: 1, contentAt: 999, media: [{}] }, { seq: 2, contentAt: -5, media: [{}] }]);
  assert.deepEqual(clamped.map((p) => p.text), ['', 'abc', '']);
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
