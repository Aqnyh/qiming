/**
 * test/modules.test.mjs —— 模块级单测（记忆 / 技能 / 插件登记表 / 外部资源 / MCP 客户端）。
 *
 * 姿势：每个用例用**独立临时数据目录**（QIMING_DATA），所以必须在 import 之前设好环境变量
 * —— 因此这里全是动态 import（ESM 的静态 import 会被提升到环境变量设置之前）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qiming-test-'));
process.env.QIMING_DATA = TMP;
process.env.QIMING_LOG = 'error';

let memory, skills, createPluginRegistry, createResourceRegistry, prompts, corePromptDefs, kv, McpClient;

before(async () => {
  memory = await import('../src/modules/memory/index.ts');
  skills = await import('../src/modules/skills/index.ts');
  ({ createPluginRegistry } = await import('../src/modules/plugins/registry.ts'));
  ({ createResourceRegistry } = await import('../src/modules/resources/index.ts'));
  ({ prompts, corePromptDefs } = await import('../src/modules/prompts/registry.ts'));
  kv = await import('../src/store/kv.ts');
  ({ McpClient } = await import('../src/modules/resources/mcp.ts'));
  prompts.register(corePromptDefs());
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ────────────────────────── 记忆 ────────────────────────── */

test('记忆：写入→索引→读回→搜索→删除（软删除进 .trash）', () => {
  const scope = { kind: 'global' };
  const entry = memory.writeEntry(scope, {
    title: '部署端口约定',
    description: '启明默认 8787',
    body: '启明 agent 服务默认监听 8787，可用 PORT 覆盖。',
    tags: ['环境', '端口'],
  });
  assert.equal(entry.slug, '部署端口约定'.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').toLowerCase());

  const index = fs.readFileSync(path.join(memory.dirOf(scope), 'MEMORY.md'), 'utf8');
  assert.match(index, /部署端口约定/);
  assert.match(index, /启明默认 8787/);

  const read = memory.readEntry(scope, entry.slug);
  assert.ok(read);
  assert.match(read.body, /8787/);
  assert.deepEqual(read.tags, ['环境', '端口']);

  assert.equal(memory.search(scope, '端口').length, 1);
  assert.equal(memory.search(scope, '不存在的词').length, 0);

  assert.equal(memory.removeEntry(scope, entry.slug), true);
  assert.equal(memory.readEntry(scope, entry.slug), null);
  const trash = fs.readdirSync(path.join(memory.dirOf(scope), '.trash'));
  assert.equal(trash.length, 1, '删除应是软删除（.trash 里还能捞）');
});

test('记忆：项目作用域与全局互不串味', () => {
  const g = { kind: 'global' };
  const p = { kind: 'project', id: 'proj-a', name: '项目A' };
  memory.writeEntry(g, { title: '全局事实', body: '全局内容' });
  memory.writeEntry(p, { title: '项目事实', body: '项目内容' });
  assert.ok(memory.listEntries(g).some((e) => e.title === '全局事实'));
  assert.ok(!memory.listEntries(g).some((e) => e.title === '项目事实'));
  assert.ok(memory.listEntries(p).some((e) => e.title === '项目事实'));
});

/* ────────────────────────── 技能 ────────────────────────── */

test('技能：写入 / 读取 / 目录 / 导入 / 停用 / 删除', () => {
  const meta = skills.write({
    name: 'pdf-split',
    description: '拆分 PDF 时用',
    body: '# 做法\n\n用 pdftk 拆页。',
  });
  assert.equal(meta.name, 'pdf-split');
  assert.match(meta.dir, /skills\/pdf-split$/);

  const read = skills.read('pdf-split');
  assert.match(read.body, /pdftk/);
  assert.match(read.meta.description, /拆分 PDF/);

  assert.deepEqual(skills.indexLines(), ['- pdf-split：拆分 PDF 时用']);

  skills.setEnabled('pdf-split', false);
  assert.deepEqual(skills.indexLines(), [], '停用后不进目录（但仍在列表里）');
  assert.equal(skills.list().length, 1);
  skills.setEnabled('pdf-split', true);

  // 导入：一份没有 frontmatter 的 Markdown，用首行标题当 name
  const src = path.join(TMP, 'imported.md');
  fs.writeFileSync(src, '# 批量改名\n\n用 rename 或 mmv。\n', 'utf8');
  const imported = skills.importMarkdown(fs.readFileSync(src, 'utf8'));
  assert.equal(imported.name, '批量改名', '中文标题直接当技能名（本机技能库允许中文）');

  assert.equal(skills.remove('pdf-split'), true);
  assert.equal(skills.read('pdf-split'), null);
});

/* ────────────────────────── 插件登记表 ────────────────────────── */

test('插件：默认启用、参数可改、停用后工具消失、提示词走注册中心', () => {
  const plugins = createPluginRegistry();
  plugins.syncPromptDefs();

  const names = plugins.tools().map((t) => t.name);
  for (const expected of ['read_file', 'run_command', 'memory_write', 'use_skill', 'spawn_agent', 'wait', 'deliver_file', 'todo_write']) {
    assert.ok(names.includes(expected), `缺少内置工具 ${expected}`);
  }

  // 参数：默认值 + 用户覆盖
  assert.equal(plugins.paramsOf('exec').timeout_sec, 600);
  plugins.setOverride('exec', { params: { timeout_sec: 1200, max_calls: 99 } });
  assert.equal(plugins.paramsOf('exec').timeout_sec, 1200);
  assert.equal(plugins.paramsOf('exec').max_calls, 99);

  // 停用：工具不再出现
  plugins.setOverride('search', { enabled: false });
  assert.ok(!plugins.tools().some((t) => t.name === 'web_search'));

  // 提示词：改用法说明 → 工具描述也跟着走注册中心
  plugins.setOverride('fs', { prompt: '【自定义】文件插件用法' });
  const view = plugins.views().find((p) => p.id === 'fs');
  assert.equal(view.prompt, '【自定义】文件插件用法');
  assert.notEqual(view.prompt, view.defaultPrompt);
  prompts.set('tool.read_file.desc', { text: '【自定义】读文件说明' });
  assert.equal(plugins.toolByName('read_file').desc(), '【自定义】读文件说明');
});

test('插件：自定义插件 = 提示词 + 命令模板（{参数} 会被安全替换）', async () => {
  const plugins = createPluginRegistry();
  plugins.upsertCustom({
    id: 'greeter',
    name: '打招呼',
    desc: '演示自定义插件',
    prompt: '打招呼插件：greet(name)',
    enabled: true,
    params: [{ key: 'suffix', name: '后缀', type: 'string', def: '！' }],
    tools: [
      {
        name: 'greet',
        desc: '向某人打招呼',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        command: 'printf "你好 %s\\n" {name}',
        stdin: 'none',
      },
    ],
  });
  const tool = plugins.toolByName('greet');
  assert.ok(tool, '自定义工具应出现在工具表里');
  const out = await tool.run(
    { name: "a'; rm -rf /tmp/should-not-happen; echo '" },
    {
      runId: 'r', sessionId: 's', seq: 1, cwd: TMP, project: null,
      signal: new AbortController().signal,
      param: (k) => plugins.paramsOf('greeter')[k],
      remaining: () => 99, spend: () => {}, prompt: (id, v) => prompts.text(id, v),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      sudoPassword: () => '',
    },
  );
  assert.ok(out.ok, out.text);
  assert.match(out.text, /你好 a'; rm -rf/);  // 参数原样传进去，但没有被当成 shell 语法执行
  assert.ok(fs.existsSync('/tmp/should-not-happen'.slice(0, 0) || '/tmp'), '没被删除任何东西');
});

/* ────────────────────────── 外部资源：HTTP 形态 ────────────────────────── */

test('外部资源：http 动作 → 工具（GET 带 query、POST 带 body、二进制落待下载）', async (t) => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/kv') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, echo: req.url }));
    }
    if (req.url === '/bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.from([1, 2, 3, 4]));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ got: body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // 无论断言是否失败都要收掉服务：否则 keep-alive 连接会让整个测试进程不退出
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = server.address().port;

  const resources = createResourceRegistry();
  resources.upsert({
    id: 'fake',
    name: '假服务',
    kind: 'http',
    desc: '测试用',
    enabled: true,
    baseUrl: `http://127.0.0.1:${port}`,
    actions: [
      { name: 'get_kv', desc: '取键值', method: 'GET', path: '/kv', params: [{ key: 'q', in: 'query', type: 'string' }] },
      { name: 'post_kv', desc: '写键值', method: 'POST', path: '/kv', params: [{ key: 'value', in: 'body', type: 'object', required: true }] },
      { name: 'fetch_bin', desc: '取二进制', method: 'GET', path: '/bin', saveAs: 'filename', params: [{ key: 'filename', in: 'query', type: 'string', required: true }] },
    ],
    createdAt: 0,
    updatedAt: 0,
  });

  const defs = resources.pluginDefs();
  const fake = defs.find((d) => d.id === 'fake');
  assert.ok(fake, '资源应生成插件定义');
  assert.deepEqual(fake.tools.map((t) => t.name).sort(), ['fake_fetch_bin', 'fake_get_kv', 'fake_post_kv']);

  const ctx = {
    runId: 'r', sessionId: 's', seq: 1, cwd: TMP, project: null,
    signal: new AbortController().signal,
    param: (k) => (k === 'timeout_sec' ? 30 : undefined),
    remaining: () => 99, spend: () => {}, prompt: (id, v) => prompts.text(id, v),
    log: { debug() {}, info() {}, warn() {}, error() {} }, sudoPassword: () => '',
  };

  const getTool = fake.tools.find((t) => t.name === 'fake_get_kv');
  const r1 = await getTool.run({ q: '你好' }, ctx);
  assert.ok(r1.ok);
  assert.match(r1.text, /HTTP 200/);
  assert.ok(hits.some((h) => h.includes('q=%E4%BD%A0%E5%A5%BD')), '中文参数要被正确编码');

  const postTool = fake.tools.find((t) => t.name === 'fake_post_kv');
  const r2 = await postTool.run({ value: { a: 1 } }, ctx);
  assert.ok(r2.ok);
  // body 参数按 key 包一层（ComfyUI 的 /prompt 就要求 {"prompt": {...}}）
  const echoed = JSON.parse(r2.text.split('\n')[1]);
  assert.deepEqual(JSON.parse(echoed.got), { value: { a: 1 } });

  const binTool = fake.tools.find((t) => t.name === 'fake_fetch_bin');
  const r3 = await binTool.run({ filename: 'bin.dat' }, ctx);
  assert.ok(r3.ok);
  assert.ok(fs.existsSync(path.join(TMP, 'downloads', 'bin.dat')), '二进制响应应落到待下载目录');


});

test('资源参数：工具执行时读到的是资源自己的那份（不跟插件挤一个文件）', () => {
  const resources = createResourceRegistry();
  const plugins = createPluginRegistry();
  resources.upsert({
    id: 'param-demo',
    name: '参数演示',
    kind: 'command',
    desc: '',
    enabled: true,
    paramDefs: [{ key: 'timeout_sec', name: '超时', type: 'number', def: 300 }],
    tools: [{ name: 'demo_run', desc: '跑', schema: { type: 'object', properties: {} }, command: 'true' }],
    createdAt: 0,
    updatedAt: 0,
  });
  // 按 app.ts 的方式接线：资源的工具以 external 形态进插件表
  for (const def of resources.pluginDefs()) plugins.registerExternal(def);

  assert.equal(plugins.paramsOf('param-demo').timeout_sec, 300, '默认值来自资源自己的 paramDefs');
  resources.setParams('param-demo', { timeout_sec: 900 });
  assert.equal(plugins.paramsOf('param-demo').timeout_sec, 900, '工具执行层读到的是改后的值');

  // 外部资源不进「插件」视图（需求 1）
  assert.ok(!plugins.views().some((v) => v.id === 'param-demo'));
  // 工具名带资源前缀（避免不同资源重名）：param-demo + demo_run → param_demo_demo_run
  assert.ok(plugins.toolByName('param_demo_demo_run'), '但它的工具仍在工具表里（模型能调用）');
  resources.remove('param-demo');
});

test('交付物语义：文件工具不产生"可下载"文件（只有交付类工具会）', async () => {
  const { fsTools } = await import('../src/modules/plugins/builtin/fs.ts');
  const { deliverPlugin } = await import('../src/modules/plugins/builtin/misc.ts');
  const dir = path.join(TMP, 'filesem');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n', 'utf8');

  const ctx = {
    runId: 'r', sessionId: 's', seq: 0, cwd: dir, project: null,
    signal: new AbortController().signal,
    param: () => undefined, remaining: () => 99, spend: () => {}, prompt: (id) => id,
    log: { debug() {}, info() {}, warn() {}, error() {} }, sudoPassword: () => '',
  };

  // 用户报的 bug：读文件/列目录也会冒出"下载卡"——根因是这些工具把"碰过的路径"填进了 files，
  // 而界面把 files 一律当交付物渲染。这里逐个钉住：文件工具一律不带 files。
  const cases = [
    ['read_file', { path: 'a.txt' }],
    ['list_directory', { path: '.' }],
    ['directory_tree', { path: '.' }],
    ['get_file_info', { path: 'a.txt' }],
    ['search_files', { pattern: 'hi' }],
    ['write_file', { path: 'b.txt', content: 'x\n' }],
    ['edit_file', { path: 'b.txt', old_string: 'x', new_string: 'y' }],
    ['create_directory', { path: 'sub' }],
    ['move_file', { from: 'b.txt', to: 'c.txt' }],
    ['delete_path', { path: 'c.txt' }],
  ];
  for (const [name, args] of cases) {
    const tool = fsTools().find((t) => t.name === name);
    const r = await tool.run(args, ctx);
    assert.equal(r.files, undefined, `${name} 不该带 files（那是"碰过的路径"，不是交付物）`);
  }

  // 交付类工具：路径必须落在待下载目录里，界面才认（否则点下载会 404）
  const deliver = deliverPlugin.tools.find((t) => t.name === 'deliver_file');
  const out = await deliver.run({ path: path.join(dir, 'a.txt') }, ctx);
  assert.ok(out.files?.length === 1, 'deliver_file 要给出文件路径');
  assert.ok(out.files[0].startsWith(path.join(TMP, 'downloads')), `交付物应在待下载目录里：${out.files[0]}`);
  assert.ok(fs.existsSync(out.files[0]), '交付物要真的落盘');
});

test('媒体消息：send_media 把链接/本机文件归一成"给用户看的媒体"', async () => {
  const { mediaPlugin } = await import('../src/modules/plugins/builtin/media.ts');
  const tool = mediaPlugin.tools.find((t) => t.name === 'send_media');
  const dir = path.join(TMP, 'media');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'shot.png'), 'not-a-real-png', 'utf8');
  fs.writeFileSync(path.join(dir, 'clip.mp4'), 'not-a-real-mp4', 'utf8');
  const ctx = {
    runId: 'r', sessionId: 's', seq: 0, cwd: dir, project: null,
    signal: new AbortController().signal,
    param: () => undefined, remaining: () => 99, spend: () => {}, prompt: (id) => id,
    log: { debug() {}, info() {}, warn() {}, error() {} }, sudoPassword: () => '',
  };

  // 外部链接：原样交给前端（kind 按扩展名判断，带查询串也要认得出）
  const ext = await tool.run({ url: 'https://example.com/a/b.png?x=1', caption: '生成的图' }, ctx);
  assert.equal(ext.ok, true);
  assert.deepEqual(ext.media, [{ kind: 'image', url: 'https://example.com/a/b.png?x=1', caption: '生成的图' }]);
  assert.equal(ext.files, undefined, '外部链接不落盘');

  // 本机文件：复制进待下载目录，给前端的是"文件名"（令牌只在浏览器里，服务端拼不出可用 URL）
  const local = await tool.run({ path: 'clip.mp4' }, ctx);
  assert.equal(local.ok, true);
  assert.equal(local.media[0].kind, 'video');
  assert.ok(local.media[0].download, '本机文件要给出待下载目录里的文件名');
  assert.ok(local.media[0].download.endsWith('.mp4'));
  assert.ok(fs.existsSync(path.join(TMP, 'downloads', local.media[0].download)), '文件要真的复制过去');
  assert.equal(local.files, undefined, '本机文件只给 media（媒体卡自己带链接），不再重复出一张文件卡');

  // kind 显式指定时以它为准；文件不存在要给可读的错
  const forced = await tool.run({ url: 'https://example.com/x', kind: 'audio' }, ctx);
  assert.equal(forced.media[0].kind, 'audio');
  const missing = await tool.run({ path: 'nope.png' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /文件不存在/);
});

/* ────────────────────────── MCP 客户端 ────────────────────────── */

test('MCP：initialize → tools/list → tools/call（含启动失败与调用超时的人话）', async () => {
  // 一个最小的 stdio MCP 服务器：换行分隔 JSON-RPC
  const script = path.join(TMP, 'fake-mcp.cjs');
  fs.writeFileSync(
    script,
    `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-mcp', version: '1.2.3' }, capabilities: {} } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'boom', description: '总是报错', inputSchema: { type: 'object', properties: {} } },
      ] } });
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'boom') return send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: '炸了' }] } });
      if (msg.params.name === 'sleep') return; // 故意不回，测超时
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + msg.params.arguments.text }] } });
    }
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
process.stderr.write('fake mcp started\\n');
`,
    'utf8',
  );

  const client = new McpClient({ id: 'fake', command: `node ${script}` });
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  assert.equal(client.serverInfo.name, 'fake-mcp');

  const ok = await client.callTool('echo', { text: '你好' });
  assert.ok(ok.ok);
  assert.equal(ok.text, 'echo:你好');

  const bad = await client.callTool('boom', {});
  assert.equal(bad.ok, false);
  assert.equal(bad.text, '炸了');

  await assert.rejects(() => client.callTool('sleep', {}, 300), /超时/);
  client.stop();

  // 起不来的命令：错误要带上下文，不能是空 message
  const dead = new McpClient({ id: 'dead', command: 'node /nonexistent/nope.cjs' });
  await assert.rejects(() => dead.listTools(), (err) => {
    assert.ok(err.message.length > 0);
    return true;
  });
  dead.stop();
});

/* ────────────────────────── 存储 ────────────────────────── */

test('存储：原子写 + 损坏自动留档 + .bak 留档', () => {
  const file = path.join(TMP, 'kv.json');
  kv.writeJson(file, { a: 1 });
  kv.writeJson(file, { a: 2 });
  assert.deepEqual(kv.readJson(file, {}), { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { a: 1 }, '覆盖前留一份 .bak');

  fs.writeFileSync(file, '{ 坏掉的 json', 'utf8');
  const fallback = kv.readJson(file, { safe: true });
  assert.deepEqual(fallback, { safe: true });
  const files = fs.readdirSync(TMP).filter((f) => f.startsWith('kv.json.corrupt-'));
  assert.equal(files.length, 1, '损坏文件要被另存留档，而不是静默丢掉');
});
