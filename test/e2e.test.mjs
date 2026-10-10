/**
 * test/e2e.test.mjs —— 端到端：真起服务、真起假上游，跑完整循环。
 *
 * 假上游（本文件内起的 HTTP 服务）扮演 OpenAI 兼容端点：
 *   第一条请求 → 回一个 write_file 工具调用（带 reasoning_content 与分片参数）
 *   之后（最后一条消息是 tool 结果）→ 回最终正文
 * 这样能在**没有真实模型**的前提下验证：循环、工具执行、落盘、事件流、
 * 按需取详情（call/thinking）、多会话并发、插话。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qiming-e2e-'));
const PROJECT_DIR = path.join(TMP, 'proj');
fs.mkdirSync(PROJECT_DIR, { recursive: true });

let upstream;
let server;
let base;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/* ────────────────────────── 假上游 ────────────────────────── */

function startUpstream() {
  const seen = [];
  let faultCalls = 0;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ url: req.url, body });
      faultCalls += 1;
      // SSE 辅助函数要在故障分支**之前**定义（故障分支也要用；放在后面会因 TDZ 抛错、响应永不结束）
      const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta, finish = null) =>
        write({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
      /* ── 故障注入（上游鲁棒性用例用）：消息里写「故障:xxx」就切到对应模式 ──
         这些模式故意不按"正常上游"出牌，用来验证循环的守卫是否真的兜住了。 */
      // 故障标记看**整段对话**里的用户消息（续跑时最后一条是循环注入的话，标记不在了）
      const fault = /故障:([\w-]+)/.exec(
        body.messages.filter((m) => m.role === 'user').map((m) => String(m.content ?? '')).join(' '),
      )?.[1];
      if (fault === 'cut-clean') {
        // 干净结束但**不给收尾标记**（既无 finish_reason 也无 [DONE]）——"半句停住"的经典形态
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `第${faultCalls}次半句` }, finish_reason: null }] })}\n\n`);
        return res.end();
      }
      if (fault === '429') {
        // 只对"这一段对话的第一次调用"限流（用对话里的用户消息条数判定，别用全局计数器）
        if (body.messages.filter((m) => m.role === 'user').length === 1) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
          return res.end('{"error":"慢点"}');
        }
        chunk({ content: '重试后成功了' });
        chunk({}, 'stop');
        return res.end('data: [DONE]\n\n');
      }
      if (fault === 'trunc') {
        // 工具参数永远不完整 + finish_reason=length
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","conte' } }] });
        chunk({}, 'length');
        return res.end('data: [DONE]\n\n');
      }
      if (fault === 'stall') {
        // 连上就再也不吐字（不 end、不 destroy）——停滞看门狗的靶子
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const last = body.messages?.[body.messages.length - 1];
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const sentToolResult = body.messages?.some((m) => m.role === 'tool');
      const isToolsRequest = hasTools && last?.role === 'user';
      if (sentToolResult) {
        // 第二轮：给最终回答（带思考与 usage）
        chunk({ reasoning_content: '工具已执行，我来总结。' });
        chunk({ content: '已写好文件。' });
        chunk({}, 'stop');
        write({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } });
        return res.end('data: [DONE]\n\n');
      }
      /* 超慢任务：200 片 × 300ms ≈ 60s 的窗口。
         队列用例要"入队 → 查看 → 删除"，需要运行**确实还在跑**的确定窗口 ——
         3.6s 的慢流在机器忙时可能刚好错过（实测偶发：入队的瞬间这一轮已经收尾，
         队列被自动兑现成下一段运行，于是 GET 看到空队列）。 */
      if (String(last?.content ?? '').includes('超慢任务')) {
        let i = 0;
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) return clearInterval(timer);
          i += 1;
          chunk({ content: `慢${i}…` });
          if (i >= 200) {
            clearInterval(timer);
            chunk({}, 'stop');
            res.end('data: [DONE]\n\n');
          }
        }, 300);
        return;
      }
      // 慢任务：慢慢吐 30 片（每片 120ms ≈ 3.6s），中途可被打断 —— 测"立即执行"用
      if (String(last?.content ?? '').includes('慢任务')) {
        let i = 0;
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) return clearInterval(timer);
          i += 1;
          chunk({ content: `第${i}片…` });
          if (i >= 30) {
            clearInterval(timer);
            chunk({}, 'stop');
            res.end('data: [DONE]\n\n');
          }
        }, 120);
        return;
      }
      if (String(last?.content ?? '').includes('立刻回答')) {
        chunk({ content: '收到新指令，已停下手上的事。' });
        chunk({}, 'stop');
        return res.end('data: [DONE]\n\n');
      }
      if (!isToolsRequest) {
        chunk({ content: '（没有工具可用的普通回答）' });
        chunk({}, 'stop');
        return res.end('data: [DONE]\n\n');
      }
      // 第一轮：工具调用（参数分三片发，模拟真实分片）
      chunk({ reasoning_content: '先写文件。' });
      chunk({ tool_calls: [{ index: 0, id: 'call_w1', type: 'function', function: { name: 'write_file', arguments: '{"path":' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"out/note.txt","con' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'tent":"你好\\n"}' } }] });
      chunk({}, 'tool_calls');
      return res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

/* ────────────────────────── 工具函数 ────────────────────────── */

async function waitFor(fn, { timeout = 25_000, step = 150, what = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, step));
  }
}

async function api(method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: res.status, json, text };
}

/* ────────────────────────── 起环境 ────────────────────────── */

before(async () => {
  upstream = await startUpstream();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn('node', ['server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      QIMING_DATA: TMP,
      QIMING_AUTH: 'off',
      PORT: String(port),
      HOST: '127.0.0.1',
      QIMING_LOG: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (c) => logs.push(String(c)));
  server.stderr.on('data', (c) => logs.push(String(c)));
  await waitFor(() => logs.join('').includes('启明已启动'), { what: '服务启动', timeout: 20_000 });

  const saved = await api('POST', '/api/settings', {
    providers: [
      {
        id: 'fake',
        name: '假上游',
        type: 'openai',
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        model: 'fake-1',
        apiKey: 'test-key',
      },
    ],
    activeId: 'fake',
    // 工作区设成临时目录：项目必须落在工作区之内（需求 3），测试不该依赖本机真实工作区
    workspace: TMP,
    params: { ctxLimit: 200000, callTimeoutSec: 60, retryCount: 1, maxTokens: 2048, temperature: 0.2 },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
});

after(async () => {
  server?.kill('SIGKILL');
  upstream?.srv.closeAllConnections();
  upstream?.srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ────────────────────────── 用例 ────────────────────────── */

test('端到端：一轮带工具调用的运行（事件流 / 落盘 / 按需取详情）', async () => {
  // 建项目（把会话的默认 cwd 指到临时目录）
  const proj = await api('POST', '/api/projects', { root: PROJECT_DIR, name: '测试项目' });
  assert.equal(proj.status, 200, JSON.stringify(proj.json));

  // 订阅事件流（先连后发，确保不漏事件）
  const ac = new AbortController();
  const events = [];
  const reader = (async () => {
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});

  const chat = await api('POST', '/api/chat', { text: '写一个文件', projectId: proj.json.project.id });
  assert.equal(chat.status, 200, JSON.stringify(chat.json));
  assert.ok(chat.json.runId);
  const { runId, sessionId } = chat.json;

  const done = await waitFor(
    () => events.find((e) => e.type === 'run_end' && e.runId === runId),
    { what: '运行结束事件' },
  );
  assert.equal(done.status, 'ok');

  // ① 事件：思考/正文/调用都被广播了，且**调用事件只带摘要**（正文全文不在事件里）
  assert.ok(events.some((e) => e.type === 'thinking' && e.runId === runId), '应有思考增量事件');
  assert.ok(events.some((e) => e.type === 'content' && e.runId === runId), '应有正文增量事件');
  const callStart = events.find((e) => e.type === 'call' && e.runId === runId);
  assert.ok(callStart, '应有调用开始事件');
  assert.equal(callStart.call.name, 'write_file');
  assert.equal(callStart.call.state, 'running');
  assert.ok(callStart.call.argsDigest.includes('out/note.txt'), '事件里要有参数摘要');
  assert.equal(callStart.call.text, undefined, '事件里不该有工具结果全文');
  const callDone = events.find((e) => e.type === 'call_done' && e.runId === runId);
  assert.equal(callDone.call.state, 'ok');
  assert.ok(callDone.call.ms >= 0);

  // ② 文件真的写了
  const written = path.join(PROJECT_DIR, 'out/note.txt');
  assert.ok(fs.existsSync(written), `应写出 ${written}`);
  assert.equal(fs.readFileSync(written, 'utf8'), '你好\n');

  // ③ 会话落盘：两条消息，助手消息带调用摘要与统计
  const sess = await api('GET', `/api/session/${sessionId}`);
  const msgs = sess.json.session.msgs;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, '已写好文件。');
  assert.equal(msgs[1].calls.length, 1);
  assert.equal(msgs[1].calls[0].state, 'ok');
  assert.ok(msgs[1].stats.in >= 0 && msgs[1].stats.ms >= 0);
  assert.equal(msgs[1].runId, runId);

  // ④ 按需取详情：调用的完整参数与结果
  const firstSeq = msgs[1].calls[0].seq;
  assert.equal(firstSeq, 0, '调用序号从 0 起');
  const detail = await api('GET', `/api/run/${runId}/call/${firstSeq}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.name, 'write_file');
  assert.equal(detail.json.args.path, 'out/note.txt');
  assert.match(detail.json.text, /已创建|已覆盖/);

  // ⑤ 按需取详情：思考全文（注意：这个消息在**第二轮**的思考里）
  const thinking = await api('GET', `/api/run/${runId}/thinking/${msgs[1].id}`);
  assert.equal(thinking.status, 200);
  assert.match(thinking.json.text, /工具已执行/);
  await ac.abort();
  await reader;

  // ⑥ 上游收到的请求：第一轮带 tools、第二轮带 role=tool 的结果回灌
  assert.ok(upstream.seen[0].body.tools.some((t) => t.function.name === 'write_file'), '第一轮要带工具表');
  const second = upstream.seen[1];
  assert.equal(second.body.messages.at(-1).role, 'tool', '工具结果要以 tool 消息回灌');
  assert.equal(second.body.messages.at(-1).tool_call_id, 'call_w1');
});

test('端到端：工作区约束（项目必须落在工作区之内，目录选择器不许越界）', async () => {
  const outside = await api('POST', '/api/projects', { root: '/etc', name: '越界项目' });
  assert.equal(outside.status, 400);
  assert.match(outside.json.error, /工作区/);

  const outBrowse = await api('GET', '/api/browse?path=/etc');
  assert.equal(outBrowse.status, 400);

  const inBrowse = await api('GET', `/api/browse?path=${encodeURIComponent(TMP)}`);
  assert.equal(inBrowse.status, 200);
  assert.equal(inBrowse.json.path, TMP);
  assert.equal(inBrowse.json.parent, null, '工作区根没有上一层（点不出去）');
  assert.equal(inBrowse.json.workspace, TMP);

  // 改工作区后，新工作区内的目录就能选了
  const moved = await api('POST', '/api/settings', { workspace: path.dirname(TMP) });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.workspace, path.dirname(TMP));
  const back = await api('POST', '/api/settings', { workspace: TMP });
  assert.equal(back.json.workspace, TMP);

  // 项目改名与改路径
  const made = await api('POST', '/api/projects', { root: PROJECT_DIR, name: '旧名' });
  const id = made.json.project.id;
  const renamed = await api('POST', `/api/projects/${id}`, { name: '新名' });
  assert.equal(renamed.json.project.name, '新名');
  const badMove = await api('POST', `/api/projects/${id}`, { root: '/etc' });
  assert.equal(badMove.status, 400, '改路径也要守工作区');
});

test('端到端：立即执行（urgent）打断当前模型调用，新指令插到最前', async () => {
  const ac = new AbortController();
  const events = [];
  const reader = (async () => {
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});

  // 起一个"慢慢吐"的运行
  const first = await api('POST', '/api/chat', { text: '慢任务：请慢慢想很久' });
  assert.equal(first.status, 200);
  const { runId, sessionId } = first.json;
  await waitFor(() => events.some((e) => e.type === 'content' && e.runId === runId), { what: '慢任务开始出字', timeout: 10_000 });

  // 此刻立即执行：应当打断当前调用（不等它吐完 30 片）
  const t0 = Date.now();
  const second = await api('POST', '/api/chat', { sessionId, text: '改做这个：立刻回答', mode: 'urgent' });
  assert.equal(second.status, 200);
  assert.equal(second.json.steered, true);
  assert.equal(second.json.mode, 'urgent');
  assert.equal(second.json.runId, runId, '打断不换运行，还是同一段');

  const done = await waitFor(() => events.find((e) => e.type === 'run_end' && e.runId === runId), { what: '运行结束', timeout: 20_000 });
  const elapsed = Date.now() - t0;
  assert.equal(done.status, 'ok');
  assert.ok(elapsed < 3000, `应当很快收尾（实际 ${elapsed}ms）—— 慢流要 3.6s 才吐完`);

  // steer 事件两态：入队时广播 queued（多观察者都能看到队列），被取走时广播 taken
  const steers = events.filter((e) => e.type === 'steer' && e.runId === runId);
  assert.ok(steers.some((e) => e.state === 'queued'), '入队要广播 queued（别的设备才看得到队列）');
  const taken = steers.find((e) => e.state === 'taken');
  assert.ok(taken, '取走执行要广播 taken');
  assert.equal(taken.mode, 'urgent');
  assert.ok(taken.id, 'taken 事件要带条目 id（界面据此把排队条摘掉）');

  // 落盘：插话成了会话里的用户消息（刷新后仍在），且最终回答来自新指令
  const sess = await api('GET', `/api/session/${sessionId}`);
  const msgs = sess.json.session.msgs;
  const steerMsg = msgs.find((m) => m.role === 'user' && m.steer);
  assert.ok(steerMsg, '插话要落成会话消息');
  assert.equal(steerMsg.content, '改做这个：立刻回答');
  // 正文现在是"所有轮的叙述拼起来"（被打断的那半句 + 新指令的回答），所以要 contains 而不是相等
  assert.match(msgs.at(-1).content, /收到新指令，已停下手上的事。$/, '新指令的回答在最后');

  await ac.abort();
  await reader;
});

test('端到端：多会话并发各自跑完（互不阻塞、互不串数据）', async () => {
  const a = await api('POST', '/api/chat', { text: '会话 A 的任务' });
  const b = await api('POST', '/api/chat', { text: '会话 B 的任务' });
  assert.notEqual(a.json.sessionId, b.json.sessionId);

  const readContent = async (id) => {
    const s = await api('GET', `/api/session/${id}`);
    const last = s.json.session.msgs.at(-1);
    return last?.role === 'assistant' && last.stats ? last.content : null;
  };
  const [ca, cb] = await waitFor(async () => {
    const [x, y] = [await readContent(a.json.sessionId), await readContent(b.json.sessionId)];
    return x && y ? [x, y] : null;
  }, { what: '两个会话都跑完' });
  assert.equal(ca, '已写好文件。');
  assert.equal(cb, '已写好文件。');

  // 项目隔离：没绑项目的会话不该把文件写到测试项目里（它落在各自 cwd = 家目录…为免污染，
  // 这里只断言两条会话的消息没有互相串）
  const sa = await api('GET', `/api/session/${a.json.sessionId}`);
  const sb = await api('GET', `/api/session/${b.json.sessionId}`);
  assert.match(sa.json.session.msgs[0].content, /会话 A/);
  assert.match(sb.json.session.msgs[0].content, /会话 B/);
  assert.equal(sa.json.session.msgs.length, 2);
  assert.equal(sb.json.session.msgs.length, 2);
});

test('端到端：运行中再发消息 = 插话（不打断当前运行）', async () => {
  const first = await api('POST', '/api/chat', { text: '长任务开始' });
  const second = await api('POST', '/api/chat', { sessionId: first.json.sessionId, text: '补充一句：注意格式' });
  // 要么已经跑完（插话会变成新一次运行），要么被当成插话 —— 两种都合理，
  // 但**不能**是两个不同 runId 同时在跑同一条会话
  if (second.json.steered) {
    assert.equal(second.json.runId, first.json.runId);
  } else {
    assert.notEqual(second.json.runId, first.json.runId);
  }
  await waitFor(async () => {
    const s = await api('GET', `/api/session/${first.json.sessionId}`);
    const last = s.json.session.msgs.at(-1);
    return last?.role === 'assistant' && last.stats;
  }, { what: '会话跑完' });
});

test('端到端：记忆汇总（scope=all 给各作用域的计数，两个入口同一份数据）', async () => {
  // 用独立目录：PROJECT_DIR 在前面的用例里已被建过（addProject 对同根目录返回既有项目，名字会被前面的改名影响）
  const memRoot = path.join(TMP, 'mem-proj');
  fs.mkdirSync(memRoot, { recursive: true });
  const proj = await api('POST', '/api/projects', { root: memRoot, name: '记忆汇总项目' });
  const pid = proj.json.project.id;
  await api('POST', '/api/memory', { scope: 'global', title: '全局一条', body: 'x' });
  await api('POST', '/api/memory', { scope: 'project', projectId: pid, title: '项目一条', body: 'y' });

  const all = await api('GET', '/api/memory?scope=all');
  assert.equal(all.status, 200);
  const g = all.json.scopes.find((x) => x.kind === 'global');
  const pj = all.json.scopes.find((x) => x.projectId === pid);
  assert.ok(g.count >= 1, '全局计数');
  assert.equal(pj.label, '记忆汇总项目');
  assert.ok(pj.count >= 1, '项目计数');

  // 归一化：按项目作用域单独拉，条目与汇总里的一致（同一个文件、同一条记录）
  const one = await api('GET', `/api/memory?scope=project&projectId=${pid}`);
  assert.ok(one.json.entries.some((e) => e.title === '项目一条'));
  // 项目页改 → 记忆页看到（都走同一个 POST/GET）
  await api('POST', '/api/memory', { scope: 'project', projectId: pid, title: '项目一条', body: 'y2' });
  const again = await api('GET', `/api/memory?scope=project&projectId=${pid}`);
  assert.equal(again.json.entries.filter((e) => e.title === '项目一条').length, 1, '同 slug 是更新而不是新增');
});

test('上游鲁棒性：半句停住（无收尾标记）会抢救并续跑，而不是当成最终回答', async () => {
  const chat = await api('POST', '/api/chat', { text: '故障:cut-clean 问一句' });
  const { sessionId } = chat.json;
  await waitFor(async () => {
    const s = await api('GET', `/api/session/${sessionId}`);
    const last = s.json.session.msgs.at(-1);
    return last?.role === 'assistant' && last.stats;
  }, { what: '运行收尾', timeout: 60_000 });
  const s = await api('GET', `/api/session/${sessionId}`);
  const last = s.json.session.msgs.at(-1);
  assert.equal(last.error, undefined, '反复被掐断不该报成错误，而是给一段如实说明');
  assert.match(last.content, /中途断开/, '要说明"上游反复中断、已停止续跑"');
  assert.match(last.content, /第\d+次半句/, '已生成的内容要保留（抢救半成品）');
  // 上游被调用了多次（1 次原始 + 至少 1 次续跑）
  // 续跑请求里带着注入给模型的那句「接着上次的进度继续」（loop.interrupted）
  const cuts = upstream.seen.filter((x) => JSON.stringify(x.body).includes('接着上次的进度继续')).length;
  assert.ok(cuts >= 1, `应当自动续跑（续跑请求里带着续跑说明，实际 ${cuts} 次）`);
});

test('上游鲁棒性：429 会重试（不再被当成"4xx 不可重试"直接失败）', async () => {
  const before = upstream.seen.length;
  const chat = await api('POST', '/api/chat', { text: '故障:429 问一句' });
  const { sessionId } = chat.json;
  const done = await waitFor(async () => {
    const s = await api('GET', `/api/session/${sessionId}`);
    const last = s.json.session.msgs.at(-1);
    return last?.role === 'assistant' && last.stats ? last : null;
  }, { what: '运行收尾', timeout: 60_000 });
  assert.equal(done.error, undefined, '429 重试成功就不该报错');
  assert.match(done.content, /重试后成功了/);
  assert.ok(upstream.seen.length - before >= 2, '至少调用了两次（第一次 429 + 重试）');
});

test('上游鲁棒性：工具参数连续被截断会及时收手（不再烧完整个轮次预算）', async () => {
  const before = upstream.seen.length;
  const chat = await api('POST', '/api/chat', { text: '故障:trunc 用工具写文件' });
  const { sessionId } = chat.json;
  const done = await waitFor(async () => {
    const s = await api('GET', `/api/session/${sessionId}`);
    const last = s.json.session.msgs.at(-1);
    return last?.role === 'assistant' && last.stats ? last : null;
  }, { what: '运行收尾', timeout: 60_000 });
  const calls = upstream.seen.length - before;
  assert.ok(calls <= 6, `连续截断应当几次就收手（实际调用 ${calls} 次）`);
  assert.match(done.content, /截断/, '要如实说明"连续截断已停止重试"');
});

test('上游鲁棒性：停滞看门狗（连上不吐字）——识别为停滞并重试，不是"用户取消"', async () => {
  await api('POST', '/api/settings', { params: { stallSec: 1 } });
  const chat = await api('POST', '/api/chat', { text: '故障:stall 问一句' });
  const { sessionId } = chat.json;
  const done = await waitFor(async () => {
    const s = await api('GET', `/api/session/${sessionId}`);
    const last = s.json.session.msgs.at(-1);
    return last?.role === 'assistant' && last.stats ? last : null;
  }, { what: '运行收尾', timeout: 60_000 });
  assert.match(String(done.error ?? ''), /停滞/, '要报"停滞"（说明看门狗认领了它）');
  assert.doesNotMatch(String(done.error ?? ''), /请求已取消/, '不该误判成用户取消');
  await api('POST', '/api/settings', { params: { stallSec: 90 } }); // 复原，别影响别的用例
});

test('端到端：归档项目返回的是**活跃**会话列表（侧栏那份），不是归档列表', async () => {
  const root = path.join(TMP, 'arch-proj');
  fs.mkdirSync(root, { recursive: true });
  const pid = (await api('POST', '/api/projects', { root, name: '待归档项目' })).json.project.id;
  const sA = (await api('POST', '/api/sessions', { projectId: pid })).json.session.id;
  const sB = (await api('POST', '/api/sessions', { projectId: pid })).json.session.id;
  // 另有一条不属于该项目的会话，归档项目不该动它
  const other = (await api('POST', '/api/sessions', { projectId: null })).json.session.id;

  const arch = await api('POST', `/api/projects/${pid}/archive`, { archived: true });
  assert.equal(arch.status, 200);
  const ids = arch.json.sessions.map((s) => s.id);
  assert.ok(!ids.includes(sA) && !ids.includes(sB), '被归档项目的会话不该出现在返回的活跃列表里');
  assert.ok(ids.includes(other), '别的会话还在');
  assert.ok(arch.json.archivedCount >= 2, '顺带给归档条数');
  // 与侧栏真正用的那份一致
  const active = await api('GET', '/api/sessions');
  assert.deepEqual(ids.slice().sort(), active.json.sessions.map((s) => s.id).sort(), '返回的就是 GET /api/sessions 那份');

  const back = await api('POST', `/api/projects/${pid}/archive`, { archived: false });
  const ids2 = back.json.sessions.map((s) => s.id);
  assert.ok(ids2.includes(sA) && ids2.includes(sB), '恢复后它们回到活跃列表');
});

test('端到端：排队队列（入队 → 查看 → 删除），排队不进会话消息', async () => {
  const first = await api('POST', '/api/chat', { text: '超慢任务：这一轮会跑很久' });
  assert.equal(first.status, 200);
  const sid = first.json.sessionId;

  // 运行中再发 = 入队（不再直接插进对话）
  const q = await api('POST', '/api/chat', { sessionId: sid, text: '排队中的补充说明' });
  assert.equal(q.json.steered, true);
  assert.equal(q.json.mode, 'steer');
  assert.ok(q.json.item?.id, '入队要返回条目 id（界面才能单独删除/立即执行）');

  const list = await api('GET', `/api/run/queue?sessionId=${sid}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.items.map((i) => i.id), [q.json.item.id]);

  // 还没执行 → 会话里不该有它
  const sess = await api('GET', `/api/session/${sid}`);
  assert.ok(!sess.json.session.msgs.some((m) => m.content === '排队中的补充说明'), '排队的消息不该进会话');

  // 删除
  const del = await api('POST', '/api/run/queue', { sessionId: sid, id: q.json.item.id, action: 'remove' });
  assert.equal(del.json.ok, true);
  assert.deepEqual(del.json.items, [], '删完队列应为空');
});

test('端到端：运行结束时把排队中的消息接着执行（不会永远挂着）', async () => {
  const first = await api('POST', '/api/chat', { text: '慢任务：慢慢想很久' });
  const sid = first.json.sessionId;
  const queued = '排队的话，这一轮跑完再执行';
  const q = await api('POST', '/api/chat', { sessionId: sid, text: queued });
  assert.equal(q.json.steered, true);

  const msgs = await waitFor(async () => {
    const s = await api('GET', `/api/session/${sid}`);
    const list = s.json.session.msgs;
    const last = list.at(-1);
    const done = list.some((m) => m.content === queued) && last?.role === 'assistant' && last.stats && (s.json.queue ?? []).length === 0;
    return done ? list : null;
  }, { what: '排队消息被自动执行', timeout: 90_000 });
  assert.ok(msgs.some((m) => m.content === queued), '排队的消息最终以正常用户消息落进会话');
});

test('端到端：队内「立即执行」打断当前调用并插到最前', async () => {
  const first = await api('POST', '/api/chat', { text: '超慢任务：这一轮会跑很久' });
  const sid = first.json.sessionId;
  const q = await api('POST', '/api/chat', { sessionId: sid, text: '改做这个：立刻回答' });
  assert.equal(q.json.steered, true);

  const t0 = Date.now();
  const ex = await api('POST', '/api/run/queue', { sessionId: sid, id: q.json.item.id, action: 'execute' });
  assert.equal(ex.json.ok, true);
  assert.equal(ex.json.items.find((i) => i.id === q.json.item.id)?.mode, 'urgent', '点过立即执行的条目应标成 urgent');

  const done = await waitFor(async () => {
    const s = await api('GET', `/api/session/${sid}`);
    const last = s.json.session.msgs.at(-1);
    return last?.role === 'assistant' && last.stats ? last : null;
  }, { what: '运行收尾', timeout: 30_000 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `应当很快被打断（实际 ${elapsed}ms；慢流要 3.6s 才吐完）`);
  assert.match(done.content, /收到新指令/);
});

test('端到端：版本自检（前端 bundle 指纹 = 服务端进程指纹）', async () => {
  const v = await api('GET', '/api/version');
  assert.equal(v.status, 200);
  assert.ok(v.json.stamp, '服务端要报自己的源码指纹');
  assert.ok(v.json.startedAt > 0 && v.json.pid > 0);

  // bundle 是构建时生成的，里面嵌着"构建那一刻的后端源码指纹"。
  // 两者不一致 = 新前端打旧后端（症状：点新按钮报"没有这个接口"）——
  // 这里直接把它变成一条会失败的断言：改完后端忘了 npm run build:ui 时，测试会提醒你。
  const js = await (await fetch(`${base}/app.js`)).text();
  assert.ok(
    js.includes(v.json.stamp),
    `bundle 里的源码指纹与服务端不一致：说明 src/ 改过但前端没重新构建（跑 npm run build:ui）`,
  );

  // 未知接口的 404 文案要带"该重启了"的提示（这条是给人看的，别退化成人话都没有的 404）
  const missing = await api('GET', '/api/definitely-not-a-route');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /重启|没有这个接口/);
});

test('端到端：登录闸门（QIMING_AUTH=off 时不挡；错密码被拒）', async () => {
  const st = await api('GET', '/api/auth');
  assert.equal(st.json.authDisabled, true);

  // 关掉登录时一切照旧
  const boot = await api('GET', '/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.ok(Array.isArray(boot.json.plugins) && boot.json.plugins.length >= 9);
  assert.ok(boot.json.resources.length >= 3, '预置资源要在（ComfyUI / 屏幕 / 浏览器）');
});

test('端到端：外部资源与插件分开（资源不进插件视图）+ 提示词双通道等价', async () => {
  const plugins = (await api('GET', '/api/plugins')).json.plugins;
  const ids = plugins.map((p) => p.id);
  for (const res of ['comfyui', 'screen', 'browser']) {
    assert.ok(!ids.includes(res), `外部资源 ${res} 不该出现在插件视图里`);
  }
  assert.ok(ids.includes('fs') && ids.includes('exec'), '内置插件仍在');

  // 资源的工具照样进模型工具表（这才是"能调用"）—— 从 /api/bootstrap 的插件视图看不到，
  // 但工具表由 /api/plugins 之外的路径提供：这里用资源视图核对工具数
  const res = (await api('GET', '/api/resources')).json.resources;
  const comfy = res.find((r) => r.id === 'comfyui');
  assert.ok(comfy.toolList.length >= 5, 'ComfyUI 的工具挂在资源上');
  assert.ok(comfy.paramDefs.some((d) => d.key === 'timeout_sec'), '资源带自己的参数定义');
  assert.equal(typeof comfy.params.timeout_sec, 'number');
  assert.ok(comfy.prompt.length > 0, '资源视图要带出生效的提示词文本');

  // 提示词双通道：插件页改 ↔ 提示词页看
  await api('POST', '/api/plugins/fs', { prompt: '【插件页改的】' });
  let entry = (await api('GET', '/api/prompts')).json.prompts.find((p) => p.id === 'plugin.fs.usage');
  assert.equal(entry.text, '【插件页改的】');
  assert.equal(entry.changed, true);
  assert.ok(entry.group.startsWith('plugin:'), '插件条目归 plugin:<id> 组');

  // 反向：提示词页改 ↔ 插件页看
  await api('POST', '/api/prompts/plugin.fs.usage', { text: '【提示词页改的】' });
  const fsView = (await api('GET', '/api/plugins')).json.plugins.find((p) => p.id === 'fs');
  assert.equal(fsView.prompt, '【提示词页改的】');

  // 资源说明也是同一条：资源页改 ↔ 提示词页看
  await api('POST', '/api/resources/comfyui', { prompt: '【资源页改的】ComfyUI 说明' });
  entry = (await api('GET', '/api/prompts')).json.prompts.find((p) => p.id === 'res.comfyui.usage');
  assert.equal(entry.text, '【资源页改的】ComfyUI 说明');
  assert.equal(entry.group, 'res:comfyui', '资源条目归 res:<id> 组');
  const comfy2 = (await api('GET', '/api/resources')).json.resources.find((r) => r.id === 'comfyui');
  assert.equal(comfy2.prompt, '【资源页改的】ComfyUI 说明');

  // 资源参数改完立刻生效（存在资源自己那里）
  await api('POST', '/api/resources/comfyui', { params: { timeout_sec: 777 } });
  const comfy3 = (await api('GET', '/api/resources')).json.resources.find((r) => r.id === 'comfyui');
  assert.equal(comfy3.params.timeout_sec, 777);
});

test('端到端：直接改文件就能加插件（热加载，不用重启）', async () => {
  const file = path.join(TMP, 'plugins.json');
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  before.custom = [
    ...(before.custom ?? []).filter((c) => c.id !== 'by-file'),
    {
      id: 'by-file',
      name: '文件加进来的插件',
      desc: 'agent 直接改文件新增',
      prompt: '文件插件：by_file_tool(text)',
      enabled: true,
      params: [],
      tools: [
        {
          name: 'by_file_tool',
          desc: '回显',
          schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          command: "printf 'ok:%s\\n' {text}",
          stdin: 'none',
        },
      ],
    },
  ];
  before.overrides = { ...(before.overrides ?? {}), exec: { params: { timeout_sec: 4321 } } };
  fs.writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

  const found = await waitFor(
    async () => {
      const list = (await api('GET', '/api/plugins')).json.plugins;
      return list.find((p) => p.id === 'by-file') ?? null;
    },
    { what: '热加载出的新插件', timeout: 12_000, step: 500 },
  );
  assert.deepEqual(found.tools.map((t) => t.name), ['by_file_tool']);
  const exec = (await api('GET', '/api/plugins')).json.plugins.find((p) => p.id === 'exec');
  assert.equal(exec.params.find((x) => x.key === 'timeout_sec').value, 4321, '参数覆盖也一起热加载');
  // 提示词条目也跟着注册进来（新插件用法可在提示词页改）
  const entry = (await api('GET', '/api/prompts')).json.prompts.find((p) => p.id === 'plugin.by-file.usage');
  assert.ok(entry, '新插件的用法提示词条目要自动注册');

  // 半截写入不能把配置清空：写坏文件后旧状态仍在
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
  await new Promise((r) => setTimeout(r, 4500));
  const still = (await api('GET', '/api/plugins')).json.plugins;
  assert.ok(still.some((p) => p.id === 'by-file'), '坏文件不该清空内存里的配置');
});

test('端到端：插件/记忆/技能/资源四个模块的读写接口', async () => {
  // 插件：停用 exec 后工具表里就没有 run_command
  const off = await api('POST', '/api/plugins/exec', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.plugins.find((p) => p.id === 'exec').enabled, false);
  await api('POST', '/api/plugins/exec', { enabled: true });

  // 插件参数：用户填多少就是多少（没有服务端硬上限）
  await api('POST', '/api/plugins/exec', { params: { timeout_sec: 1234 } });
  const view = (await api('GET', '/api/plugins')).json.plugins.find((p) => p.id === 'exec');
  assert.equal(view.params.find((x) => x.key === 'timeout_sec').value, 1234);

  // 记忆：写入 → 列表 → 改提示词（记忆模块可读可写提示词）
  const mem = await api('POST', '/api/memory', { scope: 'global', title: '测试记忆', body: '正文' });
  assert.equal(mem.status, 200);
  const list = await api('GET', '/api/memory?scope=global');
  assert.ok(list.json.entries.some((e) => e.title === '测试记忆'));
  const prompt = (await api('GET', '/api/prompts')).json.prompts.find((p) => p.id === 'memory.index.intro');
  assert.ok(prompt, '记忆模块的提示词要注册进来');
  const edited = await api('POST', '/api/prompts/memory.index.intro', { text: '【改过的】记忆索引' });
  assert.equal(edited.status, 200);
  assert.match((await api('GET', '/api/prompts')).json.prompts.find((p) => p.id === 'memory.index.intro').text, /改过的/);
  await api('POST', '/api/prompts/memory.index.intro/reset');

  // 技能：写入 → 列表 → 删除
  const sk = await api('POST', '/api/skills', { name: 'e2e-skill', description: '测试用', body: '# 步骤\n1. 做' });
  assert.equal(sk.status, 200);
  assert.ok((await api('GET', '/api/skills')).json.skills.some((s) => s.name === 'e2e-skill'));
  await api('DELETE', '/api/skills/e2e-skill');

  // 外部资源：新增一个 http 资源 → 出现在列表与工具表里
  const res1 = await api('POST', '/api/resources', {
    id: 'demo',
    name: '演示资源',
    kind: 'http',
    desc: '演示',
    enabled: true,
    baseUrl: 'http://127.0.0.1:1',
    actions: [{ name: 'demo_ping', desc: 'ping', method: 'GET', path: '/ping' }],
  });
  assert.equal(res1.status, 200);
  const rv = (await api('GET', '/api/resources')).json.resources.find((r) => r.id === 'demo');
  assert.deepEqual(rv.toolList.map((t) => t.name), ['demo_ping'], '动作名自带资源前缀时不再叠一层');
  await api('DELETE', '/api/resources/demo');

  // 外部资源不进插件视图（工具挂在资源上，由资源页展示）
  const plugins = (await api('GET', '/api/plugins')).json.plugins;
  assert.ok(!plugins.some((p) => p.id === 'comfyui'), '外部资源不该出现在插件视图');
  const browser = (await api('GET', '/api/resources')).json.resources.find((r) => r.id === 'browser');
  assert.deepEqual(browser.toolList.map((t) => t.name), ['browser_task'], '动作名自带资源前缀时不叠层');
});
