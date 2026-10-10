/**
 * ui/lib/markdown.js —— 轻量 Markdown 渲染（不引第三方库）。
 *
 * 安全纪律（唯一不可妥协的一条）：**先转义、再拼 HTML**。
 * 先拼接再"过滤脚本"是 XSS 的经典温床，这里从源头上就不给浏览器解析原文标签的机会：
 *   1. 围栏代码块先整块摘出来（占位符接管），内容单独转义；
 *   2. 其余文本整体 escapeHtml；
 *   3. 在已转义的文本上做行内替换（行内代码/链接/加粗/斜体/删除线/裸链接）；
 *   4. 占位符还原成 <pre><code>。
 * 链接只放行 http(s)/mailto/站内相对路径，其它一律降级成纯文本。
 *
 * 支持范围故意保守：标题、围栏代码、行内代码、粗斜体、删除线、链接、引用、有序/无序列表、分割线、段落。
 * 够模型输出与用户阅读用；复杂排版不值得在客户端再实现一个 CommonMark。
 */

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const TOKEN_OPEN = '\u0000';
const TOKEN_CLOSE = '\u0001';

/** 行内渲染：入参是**已转义**的文本 */
function inline(s) {
  const keep = [];
  const stash = (html) => {
    keep.push(html);
    return `${TOKEN_OPEN}${keep.length - 1}${TOKEN_CLOSE}`;
  };

  let out = s;
  // 行内代码：先收起，里面的 * _ 不该再参与替换
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code class="md-code">${code}</code>`));
  /* 图片：http(s) 或站内路径 → 真的渲染成图（外面套一层链接，点开看原图）。
     其它协议（javascript: 等）仍然只当文本 —— 与 anchor() 同一套白名单。 */
  out = out.replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (_m, alt, href) => {
    const h = String(href ?? '').trim();
    if (!/^(https?:|\/|\.\/)/i.test(h)) return stash(anchor(alt || h, h));
    return stash(`<a href="${h}" target="_blank" rel="noreferrer noopener"><img class="md-img" src="${h}" alt="${alt}" loading="lazy"></a>`);
  });
  out = out.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_m, label, href) => stash(anchor(label, href)));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // 斜体：要求星号两边不是空白，避免把 `a * b` 之类的算式吃掉
  out = out.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*/g, '$1<em>$2</em>');
  // 裸链接（此时 markdown 链接已被占位符收走，不会互相打架）
  out = out.replace(/(https?:\/\/[^\s<>"']+)/g, (m) => `<a href="${m}" target="_blank" rel="noreferrer noopener">${m}</a>`);
  // 还原占位符
  out = out.replace(new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_CLOSE}`, 'g'), (_m, i) => keep[Number(i)] ?? '');
  return out;
}

/** 链接：label 与 href 都已转义；不放行 javascript: 等协议 */
function anchor(label, href) {
  const h = String(href ?? '').trim();
  if (/^(https?:|mailto:|\/|\.\/|#)/i.test(h)) {
    return `<a href="${h}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  }
  return label;
}

/** 主入口：Markdown → HTML 字符串（调用方用 dangerouslySetInnerHTML 挂上） */
export function renderMarkdown(src) {
  const text = String(src ?? '');
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const html = [];

  const takeCodeBlock = (i) => {
    const lang = /^```+\s*([\w+#.-]*)\s*$/.exec(lines[i])?.[1] ?? '';
    const buf = [];
    let j = i + 1;
    while (j < lines.length && !/^```/.test(lines[j])) buf.push(lines[j++]);
    const cls = lang ? ` class="md-lang"` : '';
    blocks.push(`<pre class="md-pre"><code${cls} data-lang="${escapeHtml(lang)}">${escapeHtml(buf.join('\n'))}</code></pre>`);
    html.push(`${TOKEN_OPEN}B${blocks.length - 1}${TOKEN_CLOSE}`);
    return j + 1; // 跳过结束围栏（没有结束围栏就吃到文末）
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      i = takeCodeBlock(i);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const n = Math.min(6, h[1].length);
      html.push(`<h${n}>${inline(escapeHtml(h[2]))}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(`<li>${inline(escapeHtml(m[2]))}</li>`);
        i++;
      }
      html.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    // 段落：连续的非空、非块起始行合并（换行保留为 <br>）
    const buf = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim() || /^```/.test(l) || /^(#{1,6})\s+/.test(l) || /^\s*>\s?/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l)) break;
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) break;
      buf.push(l);
      i++;
    }
    if (buf.length) html.push(`<p>${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  }

  return html
    .join('\n')
    .replace(new RegExp(`${TOKEN_OPEN}B(\\d+)${TOKEN_CLOSE}`, 'g'), (_m, idx) => blocks[Number(idx)] ?? '');
}
