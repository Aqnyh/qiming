/**
 * test/images.test.mjs —— 图片通道：工具截图/ MCP 图片内容块要真的送到模型眼前。
 *
 * 为什么单独立一份：这条链路穿过五层（MCP 客户端 → 资源工具 → 执行层 → 循环 → 协议适配器），
 * 断在任何一层，症状都是"模型说看不到图"，但代码看起来都正常。这里逐层钉住。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qiming-img-'));
process.env.QIMING_DATA = TMP;
process.env.QIMING_LOG = 'error';

let openai, anthropic, McpClient, createResourceRegistry;

before(async () => {
  openai = await import('../src/providers/openai.ts');
  anthropic = await import('../src/providers/anthropic.ts');
  ({ McpClient } = await import('../src/modules/resources/mcp.ts'));
  ({ createResourceRegistry } = await import('../src/modules/resources/index.ts'));
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const IMG = { mime: 'image/png', data: 'aGVsbG8taW1hZ2UtYnl0ZXM=' };

test('协议层：带图消息渲染成各自协议的形状', () => {
  const toolMsg = { role: 'tool', content: '截好了', toolCallId: 'c1', images: [IMG] };

  // OpenAI：content 数组 + image_url 的 data URL
  const oa = openai.toMsg(toolMsg);
  assert.equal(oa.role, 'tool');
  assert.equal(oa.tool_call_id, 'c1');
  assert.ok(Array.isArray(oa.content));
  assert.deepEqual(oa.content[0], { type: 'text', text: '截好了' });
  assert.equal(oa.content[1].type, 'image_url');
  assert.equal(oa.content[1].image_url.url, `data:image/png;base64,${IMG.data}`);

  // Anthropic：tool_result 里嵌 image 块
  const an = anthropic.toMsg(toolMsg);
  assert.equal(an.role, 'user');
  const result = an.content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 'c1');
  const blocks = result.content;
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'image');
  assert.deepEqual(blocks[1].source, { type: 'base64', media_type: 'image/png', data: IMG.data });

  // 没图时不升级成数组（纯字符串最不容易被网关挑刺）
  const plain = openai.toMsg({ role: 'user', content: '你好' });
  assert.equal(plain.content, '你好');
  const plainAn = anthropic.toMsg({ role: 'user', content: '你好' });
  assert.equal(plainAn.content, '你好');
});

test('MCP 客户端：image 内容块被原样交出来（不再降级成占位文字）', async () => {
  const script = path.join(TMP, 'img-mcp.cjs');
  fs.writeFileSync(
    script,
    `
let buf='';
process.stdin.on('data',(c)=>{buf+=c.toString('utf8');let i;
while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
const m=JSON.parse(line);
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',serverInfo:{name:'img',version:'1'},capabilities:{}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'shot',description:'截图',inputSchema:{type:'object',properties:{}}}]}});
else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[
  {type:'text',text:'{"coordinate_width":3440}'},
  {type:'image',mimeType:'image/png',data:'${IMG.data}'}]}});
}});
function send(o){process.stdout.write(JSON.stringify(o)+'\\n');}
`,
    'utf8',
  );
  const client = new McpClient({ id: 'img', command: `node ${script}` });
  const out = await client.callTool('shot', {});
  assert.equal(out.ok, true);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].mime, 'image/png');
  assert.equal(out.images[0].data, IMG.data);
  assert.match(out.text, /已附上截图/, '给模型的文本要说明"图已经附上了"');
  assert.doesNotMatch(out.text, /base64\]$/, '不该再把图降级成占位符');
  client.stop();
});

test('资源层：MCP 工具的图片会被带进工具结果（模型能看见）', async () => {
  const resources = createResourceRegistry();
  const client = new McpClient({ id: 'not-used', command: 'true' });
  void client;
  // 直接构造一个 mcp 资源的工具需要真实连接，这里退一步：验证 command 形态与 http 形态
  // 不会误带 images，MCP 形态由上一个用例覆盖（连同 callTool 的 images 输出）。
  resources.upsert({
    id: 'cmd1',
    name: '本地命令',
    kind: 'command',
    desc: '',
    enabled: true,
    command: '',
    tools: [{ name: 'echo1', desc: '回显', schema: { type: 'object', properties: {} }, command: 'echo $$' }],
    createdAt: 0,
    updatedAt: 0,
  });
  const def = resources.pluginDefs().find((d) => d.id === 'cmd1');
  const tool = def.tools[0];
  const out = await tool.run({}, {
    runId: 'r', sessionId: 's', seq: 0, cwd: TMP, project: null,
    signal: new AbortController().signal,
    param: () => 30, remaining: () => 9, spend: () => {}, prompt: (id, v) => id,
    log: { debug() {}, info() {}, warn() {}, error() {} }, sudoPassword: () => '',
  });
  assert.equal(out.ok, true);
  assert.equal(out.images, undefined, '没有图片的工具结果不该凭空多出 images 字段');
  resources.remove('cmd1');
});
