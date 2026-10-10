/* test/providers.test.mjs —— 模型协议层单测（node:test + node:http，只用 Node 内置模块，零第三方依赖）
 *
 *  覆盖三块：
 *    ① 纯状态机：sse.ts / think.ts / textcalls.ts —— 用自造 ReadableStream 逐片喂字节，
 *       故意把 SSE 事件、<think> 标签、DSML/XML 调用块切在中间，测跨 chunk 兜底；
 *    ② 端到端：本地 node:http 服务器扮演 OpenAI 与 Anthropic 上游，喂既定 SSE 脚本，
 *       断言 chat() 的事件序列与**实际发出的请求体**（tools / system / tool_call_id /
 *       thinking 签名 / max_tokens / extraBody / 会话头）；
 *    ③ 协议层公共约定：errorText、session 头规则、joinUrl、buildBody。
 *
 *  运行：cd qiming && node --test test/providers.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sseEvents, parseToolArgs, stopReason } from '../src/providers/sse.ts';
import { thinkSplitter } from '../src/providers/think.ts';
import { textCallSplitter } from '../src/providers/textcalls.ts';
import { buildBody as openaiBuildBody } from '../src/providers/openai.ts';
import { buildBody as anthropicBuildBody } from '../src/providers/anthropic.ts';
import {
  chat, listModels, errorText, joinUrl, mergeRequestHeaders, sessionHeaderFor, sessionValue,
} from '../src/providers/index.ts';

/* ============================ 测试脚手架 ============================ */

const encoder = new TextEncoder();

/** 自造流：每个字符串一片，逐片喂（分帧完全由测试控制，不靠 TCP 行为） */
function streamOf(chunks) {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(encoder.encode(ch));
      c.close();
    },
  });
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** OpenAI 风格一条 data 事件（eol 可换成 \r\n） */
const sseData = (obj, eol = '\n') => 'data: ' + JSON.stringify(obj) + eol + eol;
/** Anthropic 风格一条带事件名的事件 */
const anthEvent = (type, obj) => 'event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n';

/** 起一个本地上游；handler(req, res)；records 收集每个请求的 url/headers/body */
async function startServer(handler) {
  const records = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      records.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      handler(req, res, raw, records.length - 1);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    records,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/** 逐片写 SSE 脚本的响应器（片间 1ms，制造真实的分段到达） */
function sseResponder(pieces, { status = 200, body = '' } = {}) {
  return (req, res) => {
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
    let i = 0;
    const pump = () => {
      if (i >= pieces.length || res.destroyed) {
        try { res.end(); } catch { /* 客户端已断 */ }
        return;
      }
      try { res.write(pieces[i++]); } catch { return; }
      setTimeout(pump, 1);
    };
    pump();
  };
}

const baseCfg = {
  id: 'test', name: '测试', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'sk-test', model: 'test-model',
};

/* ============================ 标签拼装（与源文件同样不写字面量） ============================ */

const LT = '\u003c';
const GT = '\u003e';
const FW = '\uff5c';
const dsmlTag = (name, attrs = '', closing = false) => `${LT}${closing ? '/' : ''}${FW}DSML${FW}${name}${attrs}${GT}`;
const dsml2Tag = (name, attrs = '', closing = false) => `${LT}${closing ? '/' : ''}||DSML||${name}${attrs}${GT}`;
const xmlTag = (name, attrs = '', closing = false) => `${LT}${closing ? '/' : ''}${name}${attrs}${GT}`;

/* ============================ ① sse.ts ============================ */

describe('sse.ts', () => {
  it('跨 chunk 分帧：\\r\\n 行尾、跨读拼事件、尾帧不丢', async () => {
    const evs = await collect(sseEvents(streamOf([
      'event: alpha\r\ndata: {"a": 1}\r\n\r\n',   // 整块到达（\r\n 分帧）
      'event: gam',                              // 下一事件的首行被切断（无换行，继续等）
      'ma\r\ndata: {"g": 3}\r\n\r\n',            // 补全 gamma
      'data: {"t"',                              // 尾帧：没有空行结尾，且被切成两片
      ': 4}',
    ])));
    assert.deepEqual(evs, [
      { event: 'alpha', data: '{"a": 1}' },
      { event: 'gamma', data: '{"g": 3}' },
      { event: '', data: '{"t": 4}' },
    ]);
  });

  it('多个 data: 行按 SSE 规范以 \\n 拼接（JSON 跨行，换行是合法空白）', async () => {
    const evs = await collect(sseEvents(streamOf(['event: x\ndata: {"a":\ndata: 1}\n\n'])));
    assert.deepEqual(evs, [{ event: 'x', data: '{"a":\n1}' }]);
    assert.deepEqual(JSON.parse(evs[0].data), { a: 1 });
  });

  it('无空行分帧 → 退化按行处理，流式不中断', async () => {
    const evs = await collect(sseEvents(streamOf(['data: one\ndata: two\n', 'data: th', 'ree'])));
    assert.deepEqual(evs.map((e) => e.data), ['one', 'two', 'three']);
  });

  it('消费方提前 return 时 cancel 读端（上层停止不留悬挂连接）', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"a":1}\n\n'));
        c.enqueue(encoder.encode('data: {"b":2}\n\n'));
      },
      cancel() { cancelled = true; },
    });
    for await (const ev of sseEvents(body)) {
      assert.equal(ev.data, '{"a":1}');
      break;
    }
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(cancelled, true);
  });

  it('stopReason：截断口径统一成 length', () => {
    assert.equal(stopReason('length'), 'length');
    assert.equal(stopReason('max_tokens'), 'length');
    assert.equal(stopReason('max_output_tokens'), 'length');
    assert.equal(stopReason('stop'), 'stop');
    assert.equal(stopReason('tool_calls'), 'tool_calls');
    assert.equal(stopReason(''), '');
  });

  it('parseToolArgs：解析失败不静默成空参数，raw 留给截断保护', () => {
    assert.deepEqual(parseToolArgs('{"a":1}'), { args: { a: 1 } });
    assert.deepEqual(parseToolArgs(''), { args: {} });
    assert.deepEqual(parseToolArgs(null), { args: {} });
    const bad = parseToolArgs('{"path":"/tmp');   // 半截 JSON = 被截断的参数
    assert.deepEqual(bad.args, {});
    assert.equal(bad.raw, '{"path":"/tmp');
    const arr = parseToolArgs('[1,2]');           // 解析出来不是对象同样不可信
    assert.deepEqual(arr.args, {});
    assert.equal(arr.raw, '[1,2]');
  });
});

/* ============================ ① think.ts ============================ */

describe('think.ts', () => {
  it('半个标签跨 chunk（<thi + nk>）：不丢字、不漏标签', () => {
    const sp = thinkSplitter();
    const got = [];
    got.push(...sp.feed('<thi'));                 // 半个开标签：必须扣住
    assert.deepEqual(got, []);
    got.push(...sp.feed('nk>abc</thi'));          // 半个闭标签：thinking 逐段放出
    got.push(...sp.feed('nk>done'));
    got.push(...sp.flush());
    const join = (kind) => got.filter((e) => e.kind === kind).map((e) => e.text).join('');
    assert.equal(join('thinking'), 'abc');
    assert.equal(join('content'), 'done');
  });

  it('flush 把未闭合的思考原样吐出（绝不静默吞内容）', () => {
    const sp = thinkSplitter();
    assert.deepEqual(sp.feed('前<think>没写完'), [{ kind: 'content', text: '前' }]);
    assert.deepEqual(sp.flush(), [{ kind: 'thinking', text: '没写完' }]);
  });

  it('普通正文（含 < 但非标签）不丢字', () => {
    const sp = thinkSplitter();
    let all = '';
    for (const t of ['1 < 2 ', 'a<b ', 'end']) for (const e of sp.feed(t)) all += e.text;
    for (const e of sp.flush()) all += e.text;
    assert.equal(all, '1 < 2 a<b end');
  });
});

/* ============================ ① textcalls.ts ============================ */

describe('textcalls.ts', () => {
  it('DSML 完整块跨 chunk：还原为结构化 ToolCall，前后正文不丢', () => {
    const block =
      dsmlTag('tool_calls') +
      dsmlTag('invoke', ' name="read_file"') +
      dsmlTag('parameter', ' name="path" string="true"') + '/tmp/a.txt' + dsmlTag('parameter', '', true) +
      dsmlTag('invoke', '', true) +
      dsmlTag('tool_calls', '', true);
    const cuts = [3, 17, 45, 88, 130];
    const pieces = [];
    let pos = 0;
    for (const c of cuts) { pieces.push(block.slice(pos, c)); pos = c; }
    pieces.push(block.slice(pos));

    const sp = textCallSplitter();
    let text = '';
    const calls = [];
    text += sp.feed('看 ').text;
    for (const p of pieces) {
      const r = sp.feed(p);
      text += r.text;
      calls.push(...r.calls);
    }
    text += sp.feed(' 完').text;                          // 块之后的正文同样要到
    const fin = sp.flush();
    text += fin.text;
    calls.push(...fin.calls);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'read_file');
    assert.deepEqual(calls[0].args, { path: '/tmp/a.txt' });
    assert.match(calls[0].id, /^text_\d+_/);
    assert.equal(text.replace(/\s+/g, ''), '看完');
  });

  it('DSML 退化写法（两个半角竖线、无换行）同样认得出', () => {
    const block =
      dsml2Tag('tool_calls') +
      dsml2Tag('invoke', ' name="write_file"') +
      dsml2Tag('parameter', ' name="content"') + 'hello world' + dsml2Tag('parameter', '', true) +
      dsml2Tag('invoke', '', true) +
      dsml2Tag('tool_calls', '', true);
    const sp = textCallSplitter();
    const r = sp.feed(block.slice(0, 21)) , r2 = sp.feed(block.slice(21));
    const calls = [...r.calls, ...r2.calls, ...sp.flush().calls];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'write_file');
    assert.deepEqual(calls[0].args, { content: 'hello world' });
  });

  it('XML ="..."> 简写形态（function/parameter）', () => {
    const block =
      xmlTag('tool_call') +
      xmlTag('function', '="read_file"') +
      xmlTag('parameter', '="path"') + '/tmp/b' + xmlTag('parameter', '', true) +
      xmlTag('function', '', true) +
      xmlTag('tool_call', '', true);
    const sp = textCallSplitter();
    const r = sp.feed(block.slice(0, 12));
    const r2 = sp.feed(block.slice(12));
    const calls = [...r.calls, ...r2.calls, ...sp.flush().calls];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'read_file');
    assert.deepEqual(calls[0].args, { path: '/tmp/b' });
  });

  it('tool_call 里直接是 JSON（数组形态）', () => {
    const block = xmlTag('tool_call') +
      '[{"name":"read_file","arguments":{"path":"/tmp/c"}}]' + xmlTag('tool_call', '', true);
    const sp = textCallSplitter();
    const r = sp.feed(block);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'read_file');
    assert.deepEqual(r.calls[0].args, { path: '/tmp/c' });
    assert.equal(r.text, '');
  });

  it('未闭合的调用块 flush 时原样吐回正文', () => {
    const sp = textCallSplitter();
    const a = sp.feed('开始 ' + xmlTag('tool_call') + xmlTag('function', '="x"'));
    assert.equal(a.calls.length, 0);
    const b = sp.flush();
    assert.equal(b.calls.length, 0);
    assert.equal(a.text + b.text, '开始 ' + xmlTag('tool_call') + xmlTag('function', '="x"'));
  });

  it('正文里提到半个标记：先扣住、超长后放行，一字不丢', () => {
    const sp = textCallSplitter();
    assert.equal(sp.feed('正文 ' + LT + 'tool_c').text, '正文 ');   // 扣住半个标记等后续
    const filler = 'alls 但不是调用' + '啊'.repeat(120);             // 超过 MAX_HOLD（96）→ 放行
    let text = '正文 ';
    text += sp.feed(filler).text;
    text += sp.flush().text;
    assert.equal(text, '正文 ' + LT + 'tool_c' + filler);           // 扣住的那半段一字不丢
  });

  it('未闭合且超过 MAX_BLOCK_CHARS（4MB）→ 按正文放行，不吞内容', () => {
    const sp = textCallSplitter();
    const head = xmlTag('tool_call') + 'a'.repeat(4 * 1024 * 1024);
    const out = sp.feed(head);
    assert.equal(out.calls.length, 0);
    assert.equal(out.text.length, head.length);
    assert.deepEqual(sp.flush(), { text: '', calls: [] });
  });
});

/* ============================ ② openai.ts 端到端 ============================ */

const OPENAI_SSE = [
  sseData({ choices: [{ delta: { reasoning_content: '先想' } }] }),
  sseData({ choices: [{ delta: { content: '<thi' } }] }),
  sseData({ choices: [{ delta: { content: 'nk>考虑</thi' } }] }),
  sseData({ choices: [{ delta: { content: 'nk>答案是 42' } }] }),
  sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] }),
  // \r\n 行尾 + 分片参数（真实网关两种都有）
  'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/x"}' } }] } }] }) + '\r\n\r\n',
  sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  sseData({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
  'data: [DONE]\n\n',
];

const OPENAI_TOOLS = [{
  name: 'read_file', description: '读文件',
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

describe('openai.ts chat() 端到端', () => {
  it('事件序列：reasoning/think 拆分/工具分片累积/usage/stop；[DONE] 收尾不补 stop', async () => {
    const srv = await startServer(sseResponder(OPENAI_SSE));
    try {
      const cfg = { ...baseCfg, baseUrl: srv.baseUrl + '/v1' };
      const evs = await collect(chat(cfg, [
        { role: 'system', content: '你是测试' },
        { role: 'user', content: '读 /tmp/x' },
        { role: 'assistant', content: '好的', thinking: '旧思考', toolCalls: [{ id: 'call_9', name: 'read_file', args: { path: '/a' } }] },
        { role: 'tool', toolCallId: 'call_9', content: '文件内容' },
      ], {
        tools: OPENAI_TOOLS,
        params: { temperature: 0.3, maxTokens: 123 },
        sessionId: 'sess-1',
      }));

      assert.deepEqual(evs.map((e) => e.kind), ['thinking', 'thinking', 'stop', 'tool_calls', 'usage', 'content']);
      assert.deepEqual(evs[0], { kind: 'thinking', text: '先想' });
      assert.equal(evs[1].text, '考虑');                                  // content 里的 <think> 被拆走
      assert.deepEqual(evs[2], { kind: 'stop', reason: 'tool_calls', clean: true });
      assert.deepEqual(evs[3].calls, [{ id: 'call_1', name: 'read_file', args: { path: '/tmp/x' } }]);
      assert.deepEqual(evs[4], { kind: 'usage', input: 11, output: 7 });
      assert.equal(evs[5].text, '答案是 42');                             // flush 后正文完整吐完

      const rec = srv.records[0];
      assert.equal(rec.url, '/v1/chat/completions');
      assert.equal(rec.headers.authorization, 'Bearer sk-test');
      assert.equal(rec.headers['user-agent'], 'qiming-agent/0.1');
      const body = JSON.parse(rec.body);
      assert.equal(body.model, 'test-model');
      assert.equal(body.stream, true);
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.equal(body.temperature, 0.3);
      assert.equal(body.max_tokens, 123);
      assert.equal(body.tool_choice, 'auto');
      assert.equal(body.tools.length, 1);
      assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'read_file', description: '读文件', parameters: OPENAI_TOOLS[0].schema } });
      // 消息映射：assistant.tool_calls / tool.tool_call_id / 默认不回传 thinking
      const asst = body.messages.find((m) => m.role === 'assistant');
      assert.deepEqual(asst.tool_calls, [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' } }]);
      assert.equal(asst.reasoning_content, undefined);
      const tool = body.messages.find((m) => m.role === 'tool');
      assert.equal(tool.tool_call_id, 'call_9');
      assert.equal(tool.content, '文件内容');
    } finally {
      await srv.close();
    }
  });

  it('extraBody 合并：不覆盖核心字段；echo_thinking=true 才回传 reasoning_content', async () => {
    const srv = await startServer(sseResponder(OPENAI_SSE));
    try {
      const cfg = {
        ...baseCfg, baseUrl: srv.baseUrl + '/v1',
        extraBody: { model: 'evil', stream: false, note: 'hello', echo_thinking: true, temperature: 0.9 },
      };
      const evs = await collect(chat(cfg, [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'y', thinking: '旧思考', toolCalls: [{ id: 'c1', name: 'f', args: {} }] },
        { role: 'tool', toolCallId: 'c1', content: 'r' },
      ], { params: { temperature: 0.1, maxTokens: 50 } }));
      assert.equal(evs.some((e) => e.kind === 'error'), false);
      const body = JSON.parse(srv.records[0].body);
      assert.equal(body.model, 'test-model');         // 核心字段不被 extraBody 覆盖
      assert.equal(body.stream, true);
      assert.equal(body.temperature, 0.9);            // 采样字段 extraBody 优先级更高
      assert.equal(body.note, 'hello');
      assert.equal(body.echo_thinking, undefined);    // 本层控制开关，不外发
      assert.equal(body.messages[1].reasoning_content, '旧思考');  // echo_thinking=true 才拼
    } finally {
      await srv.close();
    }
  });

  it('tools 为空时不发 tools / tool_choice 字段', async () => {
    const srv = await startServer(sseResponder(['data: [DONE]\n\n']));
    try {
      const cfg = { ...baseCfg, baseUrl: srv.baseUrl + '/v1' };
      const evs = await collect(chat(cfg, [{ role: 'user', content: 'x' }]));
      assert.deepEqual(evs, [{ kind: 'stop', reason: 'stop', clean: true }]);   // 干净读到 [DONE] → 补一个 stop
      const body = JSON.parse(srv.records[0].body);
      assert.equal('tools' in body, false);
      assert.equal('tool_choice' in body, false);
      assert.equal('max_tokens' in body, false);
      assert.equal('temperature' in body, false);
    } finally {
      await srv.close();
    }
  });

  it('正文型 DSML 调用（跨 delta 切碎）被认回来，标记不漏进正文', async () => {
    const block =
      dsmlTag('tool_calls') +
      dsmlTag('invoke', ' name="read_file"') +
      dsmlTag('parameter', ' name="path" string="true"') + '/tmp/r' + dsmlTag('parameter', '', true) +
      dsmlTag('invoke', '', true) +
      dsmlTag('tool_calls', '', true);
    const parts = [block.slice(0, 5), block.slice(5, 33), block.slice(33, 80), block.slice(80)];
    const pieces = [
      ...parts.map((text) => sseData({ choices: [{ delta: { content: text } }] })),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ];
    const srv = await startServer(sseResponder(pieces));
    try {
      const cfg = { ...baseCfg, baseUrl: srv.baseUrl + '/v1' };
      const evs = await collect(chat(cfg, [{ role: 'user', content: 'x' }]));
      const calls = evs.filter((e) => e.kind === 'tool_calls');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].calls[0].name, 'read_file');
      assert.deepEqual(calls[0].calls[0].args, { path: '/tmp/r' });
      assert.equal(evs.filter((e) => e.kind === 'content').map((e) => e.text).join(''), '');
      assert.equal(evs.find((e) => e.kind === 'stop').reason, 'stop');
    } finally {
      await srv.close();
    }
  });

  it('非 2xx：yield error（含状态码与正文片段）后 return，不 throw；retryable 按状态码', async () => {
    const srv401 = await startServer(sseResponder([], { status: 401, body: JSON.stringify({ error: { message: 'invalid api key' } }) }));
    try {
      const evs = await collect(chat({ ...baseCfg, baseUrl: srv401.baseUrl + '/v1' }, [{ role: 'user', content: 'x' }]));
      assert.equal(evs.length, 1);
      assert.equal(evs[0].kind, 'error');
      assert.match(evs[0].message, /HTTP 401/);
      assert.match(evs[0].message, /密钥/);
      assert.match(evs[0].message, /invalid api key/);
      assert.equal(evs[0].retryable, false);
    } finally {
      await srv401.close();
    }

    const srv503 = await startServer(sseResponder([], { status: 503, body: '{"error":{"message":"overloaded"}}' }));
    try {
      const evs = await collect(chat({ ...baseCfg, baseUrl: srv503.baseUrl + '/v1' }, [{ role: 'user', content: 'x' }]));
      assert.equal(evs[0].kind, 'error');
      assert.equal(evs[0].retryable, true);
      assert.match(evs[0].message, /HTTP 503/);
    } finally {
      await srv503.close();
    }
  });

  it('网络错误：error 事件（retryable），不 throw', async () => {
    const probe = await startServer(sseResponder([]));
    const deadUrl = probe.baseUrl;      // 关掉后再连 → 连接被拒
    await probe.close();
    const evs = await collect(chat({ ...baseCfg, baseUrl: deadUrl + '/v1' }, [{ role: 'user', content: 'x' }]));
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, 'error');
    assert.equal(evs[0].retryable, true);
    assert.match(evs[0].message, /无法连接/);
  });
});

describe('openai.ts buildBody / listModels', () => {
  it('reasoning 映射 reasoning_effort；off → none', () => {
    const msgs = [{ role: 'user', content: 'x' }];
    assert.equal(openaiBuildBody(baseCfg, msgs, { params: { reasoning: 'high' } }).reasoning_effort, 'high');
    assert.equal(openaiBuildBody(baseCfg, msgs, { params: { reasoning: 'off' } }).reasoning_effort, 'none');
    assert.equal('reasoning_effort' in openaiBuildBody(baseCfg, msgs, { params: { reasoning: 'default' } }), false);
  });

  it('上游干净结束但不给收尾标记 → stop(clean:false)，上层据此续跑而不是当最终回答', async () => {
    // 只吐内容就 res.end()（既无 finish_reason 也无 [DONE]）—— 很多网关/代理超时时就是这样
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '半句' }, finish_reason: null }] })}\n\n`);
      res.end();
    });
    try {
      // 注意 baseUrl 要指向这个假服务器（其它用例也是这么接的）
      const evs = await collect(chat({ ...baseCfg, baseUrl: `${srv.baseUrl}/v1` }, [{ role: 'user', content: 'hi' }]));
      const stop = evs.find((e) => e.kind === 'stop');
      assert.ok(stop, '必须给一个 stop（哪怕是"被掐断"）');
      assert.equal(stop.clean, false, 'clean:false 才是"没见到收尾标记"的信号');
      assert.equal(stop.reason, 'cut');
    } finally {
      await srv.close();
    }
  });

  it('listModels：data 优先；空则回落 models（Ollama 类网关）', async () => {
    const srv = await startServer((req, res, raw, idx) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(idx === 0 ? JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] }) : JSON.stringify({ models: [{ name: 'z' }, { id: 'y' }] }));
    });
    try {
      const cfg = { ...baseCfg, baseUrl: srv.baseUrl + '/v1' };
      assert.deepEqual(await listModels(cfg), ['a', 'b']);
      assert.deepEqual(await listModels(cfg), ['y', 'z']);
      assert.equal(srv.records[0].url, '/v1/models');
      assert.equal(srv.records[0].headers.authorization, 'Bearer sk-test');
    } finally {
      await srv.close();
    }
  });
});

/* ============================ ② anthropic.ts 端到端 ============================ */

const ANTH_SSE = [
  anthEvent('message_start', { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 20, output_tokens: 1 } } }),
  anthEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  anthEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
  anthEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
  anthEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }),
  anthEvent('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
  anthEvent('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"/tmp/a"}' } }),
  anthEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
  anthEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }),
  anthEvent('message_stop', { type: 'message_stop' }),
];

const ANTH_TOOLS = [{
  name: 'read_file', description: '读文件',
  schema: { type: 'object', properties: { path: { type: 'string' } } },
}];

describe('anthropic.ts chat() 端到端', () => {
  it('事件序列 + 请求体：system 顶层 / 严格交替合并 / tool_result 块 / thinking 签名回传 / max_tokens', async () => {
    const srv = await startServer(sseResponder(ANTH_SSE));
    try {
      const cfg = { ...baseCfg, type: 'anthropic', baseUrl: srv.baseUrl + '/v1' };
      const evs = await collect(chat(cfg, [
        { role: 'system', content: '规则一' },
        { role: 'system', content: '规则二' },
        { role: 'user', content: '读取文件' },
        { role: 'assistant', content: '', thinking: '先想', thinkingSig: 'sig==', toolCalls: [{ id: 'toolu_1', name: 'read_file', args: { path: '/tmp/a' } }] },
        { role: 'tool', toolCallId: 'toolu_1', content: '文件内容' },
        { role: 'tool', toolCallId: 'toolu_2', content: '第二个结果' },
        { role: 'user', content: '继续' },
      ], { tools: ANTH_TOOLS }));

      assert.deepEqual(evs.map((e) => e.kind), ['content', 'tool_calls', 'stop', 'usage']);
      assert.equal(evs[0].text, '你好');
      assert.deepEqual(evs[1].calls, [{ id: 'toolu_1', name: 'read_file', args: { path: '/tmp/a' } }]);
      assert.deepEqual(evs[2], { kind: 'stop', reason: 'tool_use', clean: true });
      assert.deepEqual(evs[3], { kind: 'usage', input: 20, output: 30 });   // message_start + message_delta 合并

      const rec = srv.records[0];
      assert.equal(rec.url, '/v1/messages');
      assert.equal(rec.headers['x-api-key'], 'sk-test');
      assert.equal(rec.headers['anthropic-version'], '2023-06-01');
      const body = JSON.parse(rec.body);
      assert.equal(body.max_tokens, 8192);                 // 缺省 8192（Anthropic 必填）
      assert.equal(body.system, '规则一\n\n规则二');          // system 提到顶层
      assert.equal(body.stream, true);
      assert.deepEqual(body.tools, [{ name: 'read_file', description: '读文件', input_schema: ANTH_TOOLS[0].schema }]);
      // 严格交替 + 合并：user(读取文件) / assistant(thinking+tool_use) / user(两个 tool_result + 继续)
      assert.equal(body.messages.length, 3);
      assert.deepEqual(body.messages[0], { role: 'user', content: '读取文件' });
      assert.equal(body.messages[1].role, 'assistant');
      assert.deepEqual(body.messages[1].content, [
        { type: 'thinking', thinking: '先想', signature: 'sig==' },   // 扩展思考原样回传（含签名）
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/tmp/a' } },
      ]);
      assert.equal(body.messages[2].role, 'user');
      assert.deepEqual(body.messages[2].content, [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '文件内容' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: '第二个结果' },
        { type: 'text', text: '继续' },
      ]);
    } finally {
      await srv.close();
    }
  });

  it('listModels：/v1/models 取 data.id 并排序（按 type 分派）', async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-z' }, { id: 'claude-a' }] }));
    });
    try {
      const cfg = { ...baseCfg, type: 'anthropic', baseUrl: srv.baseUrl + '/v1' };
      assert.deepEqual(await listModels(cfg), ['claude-a', 'claude-z']);
      assert.equal(srv.records[0].url, '/v1/models');
    } finally {
      await srv.close();
    }
  });
});

describe('anthropic.ts buildBody', () => {
  const msgs = [{ role: 'user', content: 'x' }];
  it('max_tokens 缺省 8192；思考预算夹到 max_tokens-1；太小时不开思考', () => {
    assert.equal(anthropicBuildBody(baseCfg, msgs).max_tokens, 8192);
    assert.equal('thinking' in anthropicBuildBody(baseCfg, msgs), false);

    const b2 = anthropicBuildBody(baseCfg, msgs, { params: { reasoning: 'high', maxTokens: 3000, temperature: 0.2 } });
    assert.deepEqual(b2.thinking, { type: 'enabled', budget_tokens: 2999 });
    assert.equal('temperature' in b2, false);            // 开思考时不指定 temperature

    const b3 = anthropicBuildBody(baseCfg, msgs, { params: { reasoning: 'low', maxTokens: 1000 } });
    assert.equal('thinking' in b3, false);               // 999 < 1024：干脆不开，让请求能发出

    const b4 = anthropicBuildBody(baseCfg, msgs, { params: { temperature: 0.5 } });
    assert.equal(b4.temperature, 0.5);                   // 未开思考 → 正常带采样参数
  });
});

/* ============================ ③ index.ts 公共约定 ============================ */

describe('index.ts', () => {
  it('errorText：状态码 + 各码一句人话 + 正文细节（500 字内），认不出不编', () => {
    const e401 = errorText(401, JSON.stringify({ error: { message: 'invalid api key' } }));
    assert.match(e401, /^HTTP 401：密钥无效或没带上（检查 API Key）｜invalid api key/);
    assert.match(errorText(403, ''), /^HTTP 403：没有权限/);
    assert.equal(errorText(404, ''), 'HTTP 404：接口地址或模型名不存在（检查 Base URL 与 model）');
    assert.match(errorText(429, 'rate limited'), /^HTTP 429：请求过于频繁或额度用尽（稍后重试）｜rate limited/);
    assert.match(errorText(529, 'overloaded'), /^HTTP 529：模型服务端错误（可稍后重试）｜overloaded/);
    assert.equal(errorText(418, 'teapot'), 'HTTP 418｜teapot');
    const long = errorText(500, 'x'.repeat(2000));
    assert.equal(long.length < 700, true);               // 正文片段有上限
  });

  it('会话头规则：opencode.ai 注入 x-opencode-session；值形状不合法不带；自定义头优先', () => {
    const mk = (baseUrl, extra = {}) => ({ ...baseCfg, baseUrl, ...extra });
    const h1 = mergeRequestHeaders({}, mk('https://opencode.ai/zen/v1'), { sessionId: 'sess-1' });
    assert.equal(h1['x-opencode-session'], 'sess-1');
    const h2 = mergeRequestHeaders({}, mk('https://api.deepseek.com/v1'), { sessionId: 'sess-1' });
    assert.equal('x-opencode-session' in h2, false);     // 非已知网关不注入
    const h3 = mergeRequestHeaders({}, mk('https://opencode.ai/v1'), { sessionId: 'bad value!' });
    assert.equal('x-opencode-session' in h3, false);     // 空值/非法值同样会被判 MissingSessionID，干脆不带
    const h4 = mergeRequestHeaders({}, mk('https://opencode.ai/v1', { sessionId: 'cfg-sess' }));
    assert.equal(h4['x-opencode-session'], 'cfg-sess');  // cfg.sessionId 兜底
    const h5 = mergeRequestHeaders({}, mk('https://opencode.ai/v1', { headers: { 'x-opencode-session': 'mine' } }), { sessionId: 'sess-1' });
    assert.equal(h5['x-opencode-session'], 'mine');      // 用户自定义头不被覆盖
    assert.equal(sessionHeaderFor('https://sub.opencode.ai/v1'), 'x-opencode-session');
    assert.equal(sessionValue('a.b-c:d'), 'a.b-c:d');
    assert.equal(sessionValue('bad value!'), '');
  });

  it('joinUrl：保留 Base URL 的版本段与查询串；非 http(s) 拒绝', () => {
    assert.equal(joinUrl('https://x.test/v1', '/chat/completions'), 'https://x.test/v1/chat/completions');
    assert.equal(joinUrl('https://x.test/v1/', '/messages'), 'https://x.test/v1/messages');
    assert.equal(joinUrl('http://127.0.0.1:8080/v1?api-version=2024', '/chat/completions'), 'http://127.0.0.1:8080/v1/chat/completions?api-version=2024');
    assert.throws(() => joinUrl('file:///tmp/x', '/chat'), /http/);
  });
});
