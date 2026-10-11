/**
 * ui/lib/diff-rows.js —— diff 的**行装配**（纯函数，不碰 DOM）：折叠区间 + 并排视图。
 *
 * 服务端（src/store/checkpoints.ts 的 parseUnifiedDiff）已经把 diff 解析成
 * `{oldNo,newNo,kind,text}` 的逐行数组了 —— 这里只做"怎么显示"：
 *   · 统一视图（unified）：上下文太长的段折起来，只留 CONTEXT 行头尾（GitHub 那个
 *     「展开 N 行」条），点一下就地展开；
 *   · 并排视图（split）：按"块"配对增删行，左右各占一栏（VS Code 那种）。
 *
 * 为什么折叠要在这里算而不是服务端：它是**视图选择**，跟展开/收起状态绑在一起
 * （用户点了展开就得把同一份数据重算成不折叠的），服务端只管给完整数据。
 */

/** 折叠时每段上下文保留的头尾行数 */
export const CONTEXT = 3;

/**
 * 统一视图的行序列。
 * @param {Array} lines 服务的 DiffLine[]
 * @param {{ expandAll?: boolean }} opts
 * @returns {Array} `{ type: 'line', line }` 或 `{ type: 'fold', count, from, to }`
 *
 * `from`/`to` 是**被藏起来的那一段**（不含已显示的头尾 3 行）——
 * 展开时 `lines.slice(from, to)` 正好补上 `count` 行。曾经记的是整段上下文的起止，
 * 于是"展开 7 行"会推 10 行、头尾各重复 3 行（行号看着像错乱）。
 */
export function unifiedRows(lines, opts = {}) {
  const list = Array.isArray(lines) ? lines : [];
  if (opts.expandAll) return list.map((line) => ({ type: 'line', line }));
  const out = [];
  let i = 0;
  while (i < list.length) {
    const line = list[i];
    if (line.kind !== 'ctx') {
      out.push({ type: 'line', line });
      i += 1;
      continue;
    }
    // 收集这一段连续的上下文
    let j = i;
    while (j < list.length && list[j].kind === 'ctx') j += 1;
    const run = j - i;
    const atTop = i === 0; // 文件开头：上面没有内容，不需要"展开上面的 3 行"
    const atBottom = j === list.length;
    const keepHead = atTop ? 0 : CONTEXT;
    const keepTail = atBottom ? 0 : CONTEXT;
    if (run <= keepHead + keepTail) {
      for (let k = i; k < j; k += 1) out.push({ type: 'line', line: list[k] });
    } else {
      for (let k = i; k < i + keepHead; k += 1) out.push({ type: 'line', line: list[k] });
      // 藏起来的只有中间那段（头尾已经单独显示了）
      out.push({ type: 'fold', count: run - keepHead - keepTail, from: i + keepHead, to: j - keepTail });
      for (let k = j - keepTail; k < j; k += 1) out.push({ type: 'line', line: list[k] });
    }
    i = j;
  }
  return out;
}

/**
 * 并排视图：一轮内的"删 + 增"配成一行（左旧右新），落单的各自占一边。
 *
 * 为什么按"块"配对而不是按索引：diff 里删 3 行加 2 行是**同一处改动**，
 * 按索引对齐会把它们错开成六行，看着像改了六处。
 *
 * @returns Array<{ left: DiffLine|null, right: DiffLine|null }>
 */
export function splitRows(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const out = [];
  let i = 0;
  while (i < list.length) {
    const line = list[i];
    if (line.kind === 'ctx') {
      out.push({ left: line, right: line });
      i += 1;
      continue;
    }
    // 收集连续的增删（不含上下文）
    let j = i;
    while (j < list.length && list[j].kind !== 'ctx') j += 1;
    const dels = [];
    const adds = [];
    for (let k = i; k < j; k += 1) (list[k].kind === 'del' ? dels : adds).push(list[k]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    i = j;
  }
  return out;
}

/**
 * 并排视图的行序列，带折叠条 —— 与统一视图**折叠在同一位置**。
 *
 * 为什么要专门一个函数：折叠是按"上下文段"切的，而并排要按"增删块"配对，
 * 两个切法不一样。先算统一视图（决定哪里折），再把折出来的段与配对结果交叉。
 * 展开过的段（opened 里有它的 from）直接摊平成内容行。
 *
 * @returns Array<{ left, right } | { fold: { count, from, to } }>
 */
export function splitRowsWithFolds(lines, opts = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const opened = opts.opened ?? new Set();
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    for (const row of splitRows(buf)) out.push(row);
    buf = [];
  };
  for (const r of unifiedRows(list, { expandAll: opts.expandAll })) {
    if (r.type === 'line') {
      buf.push(r.line);
      continue;
    }
    flush();
    if (opened.has(r.from)) {
      // 展开：把这段的原文行直接接上（不折叠）
      for (const line of list.slice(r.from, r.to)) buf.push(line);
      continue;
    }
    out.push({ fold: { count: r.count, from: r.from, to: r.to } });
  }
  flush();
  return out;
}
