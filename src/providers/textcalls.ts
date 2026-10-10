/**
 * src/providers/textcalls.ts —— 把「写成正文的工具调用」认回来（正文 → 结构化 ToolCall）。
 *
 * 从旧项目 agent/src/core/protocol/textcalls.js 逐字移植（状态机、正则、上限一字未改）。
 *
 * 为什么需要：不是所有上游都会把工具调用放进 delta.tool_calls。实测过的三种泄漏形态：
 *   ① DeepSeek V4 系列的 DSML 标记（小于号 + 全角竖线 ｜ + DSML + 全角竖线 ｜ + tool_calls）
 *      包住 invoke / parameter 块；上游解析器在长上下文、或模型漏掉起始标记时会把整块当正文返回。
 *      还有退化写法：竖线变成两个半角 |，各标签之间也没有换行。
 *   ② 少数实现把工具调用写成 XML（tool_call / function= / parameter=），同样漏进正文。
 *   ③ 一旦漏进正文，上层看不到 tool_calls → 把整块当「最终回答」收尾退出循环，
 *      用户那边既看到一串标记、又发现模型「没干活」。
 *
 * 流式安全的三条实测结论（原样保留）：
 *   · 只在看到**完整**的调用块后才产出 calls —— 正文里「提到」这些标记不会被误当调用；
 *   · 标记可能跨 chunk 被切开（分词后很常见），未闭合时把尾巴留在缓冲里继续等（最多 MAX_HOLD 字）；
 *   · 块一直不闭合且已超长（模型在写文件内容中途断了）→ 原样吐回正文，绝不静默吞内容；
 *     解析不出调用的块同样原样吐回正文（宁可显示得难看，也不能丢内容）。
 *
 * 移植时改了什么：
 *   · 接口按新契约收成 { text, calls }：旧实现按序产出 content/tool_calls 事件（调用可以夹在
 *     两段正文中间），新接口把正文片段拼成 text、调用收集成 calls —— 顺序信息不再逐段保留；
 *   · 旧事件的 recovered:true 标记不移植（契约 ToolCall 没有该字段）：从本模块出来的调用
 *     本来就都是「正文里认出来的」，上层按来源即可判断；
 *   · 参数 JSON 解析失败不再静默成空参数，而是按契约回填 ToolCall.raw（旧 jsonOrEmpty 的取舍）；
 *   · 标签字面量仍全部用转义拼装（源码里不出现任何「标签形态」—— 这类字面量在编辑/粘贴/
 *     工具链里被规范化或截断过一次，解析器就再也认不出来了）。
 */
import type { ToolCall } from './types.ts';
import { parseToolArgs } from './sse.ts';

const LT = '\u003c';                                       // 小于号
const GT = '\u003e';                                       // 大于号
const SLASH = '\\s*\\/\\s*';                               // 闭合标签里的斜杠（容忍空白）
const BARS = '(?:\\uff5c|\\|)\\s*(?:\\uff5c|\\|)?';         // 一或两个竖线（全角 ｜ / 半角 |，容忍空白）
/** DSML 标签：小于号 + [斜杠] + 竖线 DSML 竖线 + 名字 + [属性] + 大于号。
 *  属性用**非贪婪**取——属性后面紧跟的就是大于号；贪婪写法在「属性后没有大于号」的
 *  残缺形态下会把参数值一起吞掉（实测踩过）。 */
const dsml = (name: string, attrs: boolean): string =>
  LT + '(' + SLASH + ')?\\s*' + BARS + '\\s*DSML\\s*' + BARS + '\\s*'
  + name + '(?![\\w-])' + (attrs ? '(\\s*[^' + GT + ']*?)?\\s*' : '\\s*') + GT;
/** XML 形态的标签（第 ② 种泄漏）：属性可能是空格分隔的 name="…"，也可能是旧写法的 ="值" 简写。
 *  名字后面加个「不是单词字符」的前瞻——否则 `function_calls` 会被当成 `function` 标签吃掉。 */
const xml = (name: string, attrs: boolean): string =>
  LT + '(' + SLASH + ')?\\s*' + name + '(?![\\w-])' + (attrs ? '(\\s*[^' + GT + ']*?)?\\s*' : '\\s*') + GT;

const SRC = {
  dsmlWrapper: dsml('tool_calls', false),
  dsmlInvoke: dsml('invoke', true),
  dsmlParam: dsml('parameter', true),
  xmlCall: xml('tool_call', false),
  xmlCalls: xml('function_calls', false),
  xmlFn: xml('function', true),
  xmlParam: xml('parameter', true),
};

const NAME_ATTR = /(?:^|\s)name\s*=\s*"([^"]*)"/;
const STRING_ATTR = /(?:^|\s)string\s*=\s*"([^"]*)"/;
const FN_ATTR = /(?:^|\s)function\s*=\s*"([^"]*)"/;
const PARAM_ATTR = /(?:^|\s)parameter\s*=\s*"([^"]*)"/;
/** 旧写法的 ="值" 简写：标签名本身就是键（`<function="名字">` / `<parameter="键">`） */
const SHORT_ATTR = /^=\s*"([^"]*)"/;

/** 一个块最多等多大（没闭合又超过它 = 模型写到一半断了，原样吐回正文） */
const MAX_BLOCK_CHARS = 4 * 1024 * 1024;
/** 正文模式下最多留多少个字符等标记拼完 */
const MAX_HOLD = 96;

/** 编译一次，重复使用（每次 exec 前重置 lastIndex） */
const RX: Record<keyof typeof SRC, RegExp> = {
  dsmlWrapper: new RegExp(SRC.dsmlWrapper, 'g'),
  dsmlInvoke: new RegExp(SRC.dsmlInvoke, 'g'),
  dsmlParam: new RegExp(SRC.dsmlParam, 'g'),
  xmlCall: new RegExp(SRC.xmlCall, 'g'),
  xmlCalls: new RegExp(SRC.xmlCalls, 'g'),
  xmlFn: new RegExp(SRC.xmlFn, 'g'),
  xmlParam: new RegExp(SRC.xmlParam, 'g'),
};

type Tag = 'dsmlWrapper' | 'dsmlInvoke' | 'xmlCall' | 'xmlCalls' | 'xmlFn';

/** 在 s 的 [from, …] 里找闭合标签的位置（找不到返回 -1） */
function closeAt(rx: RegExp, s: string, from: number): number {
  rx.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) {
    if (m[1]) return m.index;                    // 捕获组 1 命中 = 这是闭合标签
    rx.lastIndex = m.index + 1;                  // 开标签：跳过继续找
  }
  return -1;
}

/** 正文流里的「开标记」：取最先出现的一个 */
const OPENS: Array<{ tag: Tag; rx: () => RegExp }> = [
  { tag: 'dsmlWrapper', rx: () => RX.dsmlWrapper },
  { tag: 'dsmlInvoke', rx: () => RX.dsmlInvoke },
  { tag: 'xmlCall', rx: () => RX.xmlCall },
  { tag: 'xmlCalls', rx: () => RX.xmlCalls },
  { tag: 'xmlFn', rx: () => RX.xmlFn },
];

function firstOpen(s: string): { tag: Tag; index: number; end: number } | null {
  let best: { tag: Tag; index: number; end: number } | null = null;
  for (const o of OPENS) {
    const rx = o.rx();
    rx.lastIndex = 0;
    const m = rx.exec(s);
    if (!m || m[1]) continue;                    // 闭合标签不是开标记
    if (!best || m.index < best.index) best = { tag: o.tag, index: m.index, end: m.index + m[0].length };
  }
  return best;
}
/** 开标记 tag → 它该等的闭合标签 */
const CLOSE_OF: Record<Tag, () => RegExp> = {
  dsmlWrapper: () => RX.dsmlWrapper,
  dsmlInvoke: () => RX.dsmlInvoke,
  xmlCall: () => RX.xmlCall,
  xmlCalls: () => RX.xmlCalls,
  xmlFn: () => RX.xmlFn,
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 参数值解码：string="true" 原样（只去掉转义引号那种 JSON 字符串壳）；否则试 JSON，失败保底字符串 */
function decodeValue(raw: unknown, isString: boolean): unknown {
  let v = String(raw == null ? '' : raw);
  v = v.replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (isString) {
    if (/^"[\s\S]*"$/.test(v)) {
      try { v = JSON.parse(v) as string; } catch { /* 保留原文 */ }
    }
    return v;
  }
  const t = v.trim();
  if (!t) return '';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (t === 'null') return null;
  if (/^[[{]/.test(t)) {
    try { return JSON.parse(t) as unknown; } catch { /* 保底字符串 */ }
  }
  return v;
}

/** 把 { name, arguments } 归一成契约的 ToolCall */
let seq = 0;
function makeCall(name: unknown, args: unknown, raw?: string): ToolCall | null {
  const nm = String(name || '').trim();
  if (!nm) return null;
  let a = args;
  // 有的实现把参数整体包成 {"arguments": {…}} / {"input": {…}}
  if (isObj(a)) {
    const keys = Object.keys(a);
    const inner = a.arguments !== undefined ? a.arguments : a.input;
    if (keys.length === 1 && isObj(inner)) a = inner;
  }
  const out: ToolCall = {
    id: 'text_' + (++seq) + '_' + Date.now().toString(36),
    name: nm,
    args: isObj(a) ? a : {},
  };
  if (raw !== undefined) out.raw = raw;
  return out;
}

/** 参数段（invoke/function 的 body）→ 参数对象 */
function parseParams(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  let found = false;
  const pRe = new RegExp('(?:' + RX.dsmlParam.source + ')|(?:' + RX.xmlParam.source + ')', 'g');
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(body))) {
    if (pm[1] || pm[3]) continue;                         // 闭合标签（两条分支的斜杠各占一个组）
    const attrs = pm[2] != null ? pm[2] : (pm[4] || '');  // 两条分支的属性各占一个组
    const key = (NAME_ATTR.exec(attrs) || PARAM_ATTR.exec(attrs) || SHORT_ATTR.exec(String(attrs).trim()) || [])[1];
    const from = pm.index + pm[0].length;
    // 参数体：到下一个 parameter 标签（开或闭）为止；退化写法（没有闭合标签）也能切对
    pRe.lastIndex = from;
    const nx = pRe.exec(body);
    const stop = nx ? nx.index : body.length;
    pRe.lastIndex = from;
    if (!key) continue;
    found = true;
    const isStr = /true/i.test((STRING_ATTR.exec(attrs) || [])[1] || '');
    args[key] = decodeValue(body.slice(from, stop), isStr);
  }
  return found ? args : null;
}

/** DSML 形态：块里可能并排多个 invoke */
function parseDsmlBlock(block: string): ToolCall[] {
  const calls: ToolCall[] = [];
  RX.dsmlInvoke.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RX.dsmlInvoke.exec(block))) {
    if (m[1]) continue;
    const from = m.index + m[0].length;
    const close = closeAt(RX.dsmlInvoke, block, from);
    const stop = close === -1 ? block.length : close;
    const name = (NAME_ATTR.exec(m[2] || '') || [])[1];
    const body = block.slice(from, stop);
    const params = parseParams(body);
    /* 块里没有 parameter 时，body 本身可能就是一段 JSON；解析失败按契约回填 raw
       （旧 jsonOrEmpty 静默成空参数，上层分辨不出「参数被截断」）。 */
    const parsed = params === null && /^\s*[[{]/.test(body) ? parseToolArgs(body) : { args: params ?? {} };
    const c = makeCall(name, parsed.args, parsed.raw);
    if (c) calls.push(c);
    RX.dsmlInvoke.lastIndex = stop;
  }
  return calls;
}

/** XML 形态：tool_call 里可能是 JSON，也可能是 function= / parameter= 结构 */
function parseXmlBlock(block: string): ToolCall[] {
  const calls: ToolCall[] = [];
  // ① 包裹里直接是一段 JSON
  const stripped = block
    .replace(new RegExp(LT + '\\/?\\s*(tool_call|function_calls)\\s*' + GT, 'g'), '')
    .trim();
  if (/^[[{]/.test(stripped)) {
    try {
      const o: unknown = JSON.parse(stripped);
      for (const it of (Array.isArray(o) ? o : [o])) {
        const fn = isObj(it) ? (isObj(it.function) ? it.function : it) : null;
        if (!fn) continue;
        let args: unknown = fn.arguments !== undefined ? fn.arguments : fn.args;
        let raw: string | undefined;
        if (typeof args === 'string') {
          const parsed = parseToolArgs(args);
          args = parsed.args;
          raw = parsed.raw;
        }
        const c = makeCall(fn.name, args, raw);
        if (c) calls.push(c);
      }
      if (calls.length) return calls;
    } catch { /* 不是 JSON，走结构解析 */ }
  }
  // ② function="name" 里若干 parameter="k"
  RX.xmlFn.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RX.xmlFn.exec(block))) {
    if (m[1]) continue;
    const from = m.index + m[0].length;
    const close = closeAt(RX.xmlFn, block, from);
    const stop = close === -1 ? block.length : close;
    const name = (FN_ATTR.exec(m[2] || '') || SHORT_ATTR.exec(String(m[2] || '').trim()) || [])[1];
    const c = makeCall(name, parseParams(block.slice(from, stop)) || {});
    if (c) calls.push(c);
    RX.xmlFn.lastIndex = stop;
  }
  return calls;
}

/** 块 → 调用数组（认不出返回空数组，调用方原样当正文） */
export function parseCallBlock(block: string): ToolCall[] {
  try {
    const calls = parseDsmlBlock(block);
    if (calls.length) return calls;
    return parseXmlBlock(block);
  } catch {
    return [];
  }
}

/** feed/flush 的产出：正文片段（已拼接）+ 认出来的调用 */
export type TextCallResult = { text: string; calls: ToolCall[] };

/**
 * 流式拆分器：feed(chunk) → { text, calls }；flush() → 收尾。
 * 块跨 chunk（标记被切开）时留在缓冲里继续等；不闭合或认不出 → 原样当正文。
 */
export function textCallSplitter(): { feed(text: string): TextCallResult; flush(): TextCallResult } {
  let buf = '';
  let open: Tag | null = null;              // 正在等的闭合标签（开标记的 tag 名）

  const step = (final: boolean): TextCallResult => {
    const texts: string[] = [];
    const calls: ToolCall[] = [];
    const done = (): TextCallResult => ({ text: texts.join(''), calls });
    for (;;) {
      if (!open) {
        const hit = firstOpen(buf);
        if (!hit) {
          if (final) {
            if (buf) texts.push(buf);
            buf = '';
            return done();
          }
          /* 标记可能被切在 chunk 中间：把最后一个小于号之后的尾巴留住继续等
             （留得住的长度有上限——那个小于号要是普通正文，下次 feed 就吐出来了）。 */
          const i = buf.lastIndexOf(LT);
          const cut = i !== -1 && buf.length - i <= MAX_HOLD ? i : buf.length;
          if (cut > 0) {
            texts.push(buf.slice(0, cut));
            buf = buf.slice(cut);
          }
          return done();
        }
        if (hit.index > 0) texts.push(buf.slice(0, hit.index));
        buf = buf.slice(hit.index);
        open = hit.tag;
        continue;
      }
      const close = closeAt(CLOSE_OF[open](), buf, 0);
      if (close === -1) {
        if (final || buf.length > MAX_BLOCK_CHARS) {      // 没闭合：原样吐回正文，绝不吞内容
          texts.push(buf);
          buf = '';
          open = null;
          return done();
        }
        return done();                                     // 继续等
      }
      /* 闭合标签按「块的种类」取：外层包裹开的等自己的闭合标签，孤儿 invoke 等 invoke 的。
         两者混用时（invoke 的闭合在外层闭合之前）不会截断错——各自只认自己的那个。 */
      const rx = CLOSE_OF[open]();
      rx.lastIndex = close;
      const cm = rx.exec(buf);
      const end = cm ? cm.index + cm[0].length : buf.length;
      const block = buf.slice(0, end);
      buf = buf.slice(end);
      open = null;
      const got = parseCallBlock(block);
      if (got.length) calls.push(...got);
      else texts.push(block);                              // 认不出 → 原样显示
    }
  };

  return {
    feed: (chunk: string) => {
      buf += String(chunk == null ? '' : chunk);
      return step(false);
    },
    flush: () => step(true),
  };
}
