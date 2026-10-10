/**
 * src/store/checkpoints.ts —— 文件改动的"比对与撤回"（影子 git 仓库）。
 *
 * 做法取自主流 harness（Claude Code 的 checkpoints、Cline 的 shadow git）：
 * **不动用户自己的项目仓库**，而是在 data/checkpoints/<会话id>/ 下另建一个 git 目录，
 * 把项目工作目录当成它的 work-tree。每次"动手前"打一个快照，
 * 于是每个快照都能回答两个问题：改了什么（diff）、怎么退回去（restore）。
 *
 * 五条实测出来的纪律（每一条都是踩过才写下的）：
 *  1. **快照打在改动之前**：记的是"动手前长什么样"。所以"撤回这次改动" = 回到它前面那个快照，
 *     与 Cline/Claude Code 的 checkpoint 语义一致。
 *  2. **别动 .gitattributes 的 -text**：一开始想用 `* -text` 避免换行符转换，
 *     结果 git 把所有文件都当**二进制**，diff 只剩一句 "Binary files differ" ——
 *     比对功能直接废掉。换行用 `core.autocrlf=false` 控制就够了。
 *  3. **撤回是"追加一个提交"，不是 reset**：reset 会把后面的快照从 HEAD 上摘掉
 *     （撤回一次之后就再也撤不回去了）。这里的做法是"恢复工作树 → 把结果提交成新快照"，
 *     历史只增不减，撤回本身也能被撤回。
 *  4. **目录外置与自排除**：影子仓库可能在项目目录**内部**（本工程自维护时就是这样），
 *     不排除就会自己吃自己。所以动态把检查点目录的相对路径写进 git 的 excludesFile。
 *  5. **失败不抛**：快照失败绝不能让文件写入失败（写文件才是正事），一律收成返回值 + 日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { CHECKPOINTS_DIR, checkpointDir } from '../util/paths.ts';
import { logger } from '../util/log.ts';

const log = logger('checkpoint');

/** 一个检查点（= 一次改动前后的分界） */
export type Checkpoint = {
  /** git commit 短 sha（对外用它引用） */
  id: string;
  /** 完整 sha（内部 restore 用） */
  sha: string;
  /** 毫秒时间戳 */
  ts: number;
  /** 这次快照对应的改动描述（哪个工具、动了什么） */
  label: string;
  /** 参与本次改动的文件（相对工作目录，最多 40 个） */
  files: string[];
  /** 下一次快照算出来的增删行数（描述"这个快照之后改了多少"） */
  added?: number;
  removed?: number;
  /** 这次快照是不是"撤回前自动备份" */
  beforeRestore?: boolean;
};

export type CheckpointRepo = {
  sessionId: string;
  cwd: string;
  /** 打一个"改动前"快照；内容没变时返回 null */
  snapshot: (label: string, files: string[], opts?: { beforeRestore?: boolean }) => Promise<Checkpoint | null>;
  /** 把工作树恢复到某个快照 */
  restore: (id: string) => Promise<{ ok: boolean; detail: string; files: string[]; removed: string[] }>;
  /** 当前工作树相对最新快照的改动 */
  diff: (id?: string) => Promise<{
    text: string;
    stat: { files: number; added: number; removed: number; list: Array<{ path: string; added: number; removed: number }> };
  }>;
  /** 有没有未快照的改动 */
  hasChanges: () => Promise<boolean>;
  /** 检查点列表（新→旧） */
  list: () => Promise<Checkpoint[]>;
  /** 删除整个检查点仓库（会话被彻底删除时用） */
  dispose: () => void;
};

/** 永远不跟踪的东西：重型目录 + 二进制/媒体 + 日志（影子仓库要小、要只装文本） */
const BASE_IGNORE = `node_modules/
.git/
dist/
build/
out/
target/
.next/
coverage/
__pycache__/
.pytest_cache/
.venv/
venv/
*.pyc
*.log
*.tmp
*.zip
*.tar
*.tar.gz
*.gz
*.7z
*.rar
*.iso
*.bin
*.exe
*.dll
*.so
*.dylib
*.woff
*.woff2
*.ttf
*.otf
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.avif
*.bmp
*.ico
*.svg
*.mp4
*.mov
*.mkv
*.webm
*.avi
*.m4v
*.mp3
*.wav
*.flac
*.ogg
*.m4a
*.aac
*.pdf
*.doc
*.docx
*.ppt
*.pptx
*.xls
*.xlsx
`;

const repos = new Map<string, CheckpointRepo | null>();

function makeRepo(sessionId: string, cwd: string): CheckpointRepo {
  const dir = checkpointDir(sessionId);
  const gitDir = path.join(dir, 'git');
  const excludeFile = path.join(dir, 'exclude');
  fs.mkdirSync(gitDir, { recursive: true });

  /**
   * 每次调用拿一个新实例并显式传 --git-dir/--work-tree。
   * simple-git 4.x 默认拦 `--git-dir`（认为是危险参数），要开
   * `unsafe.allowUnsafeConfigPaths` —— 这里的路径全由我们自己拼、不含用户输入，开关是安全的。
   */
  const git = (): SimpleGit =>
    simpleGit({ baseDir: cwd, config: [], unsafe: { allowUnsafeConfigPaths: true } });
  const R = (g: SimpleGit, ...args: string[]): Promise<string> =>
    g.raw(['--git-dir', gitDir, '--work-tree', cwd, ...args]);

  let ready: Promise<void> | null = null;

  /** 检查点目录若落在工作目录内，必须排除掉（否则影子仓库会把自己也跟踪进去） */
  function ignoreBody(): string {
    const relCheckpoints = path.relative(cwd, CHECKPOINTS_DIR);
    const extra =
      relCheckpoints && !relCheckpoints.startsWith('..') && !path.isAbsolute(relCheckpoints)
        ? `${relCheckpoints.split(path.sep).join('/')}/\n`
        : '';
    return `${BASE_IGNORE}${extra}`;
  }

  async function ensureInit(): Promise<void> {
    if (ready) return ready;
    ready = (async () => {
      const g = git();
      fs.writeFileSync(excludeFile, ignoreBody(), 'utf8');
      if (!fs.existsSync(path.join(gitDir, 'HEAD'))) await R(g, 'init', '-q', '--initial-branch=main');
      // 本地身份 + 不读用户的全局配置（否则可能被 commit.gpgsign / 钩子卡住）
      await R(g, 'config', 'user.email', 'checkpoints@qiming.local');
      await R(g, 'config', 'user.name', 'qiming-checkpoints');
      await R(g, 'config', 'core.autocrlf', 'false');
      await R(g, 'config', 'core.safecrlf', 'false');
      /* 只排除文件用 excludesFile（**不动工作目录里用户的 .gitignore**）；
         ignoreCase=false 保证大小写敏感的文件系统上行为一致；
         注意：绝不能设 `* -text`（会把所有文件判成二进制，diff 只剩"Binary files differ"）。 */
      await R(g, 'config', 'core.excludesFile', excludeFile);
      fs.writeFileSync(
        path.join(dir, 'README.txt'),
        '这是启明的文件改动检查点仓库（影子 git，只跟踪文本改动）。\n删除它只会丢失"比对与撤回"的能力，不影响项目文件本身。\n',
        'utf8',
      );
    })().catch((err) => {
      ready = null; // 下次再试
      throw err;
    });
    return ready;
  }

  async function hasHead(g: SimpleGit): Promise<boolean> {
    try {
      await R(g, 'rev-parse', '--verify', 'HEAD');
      return true;
    } catch {
      return false;
    }
  }

  /** 当前"索引 vs HEAD"的增删行数（空仓库也能跑：diff --cached 会跟空树比） */
  async function cachedStat(g: SimpleGit): Promise<{ files: number; added: number; removed: number }> {
    try {
      const out = await R(g, 'diff', '--cached', '--numstat');
      return parseNumstat(out);
    } catch {
      return { files: 0, added: 0, removed: 0 };
    }
  }

  async function snapshot(label: string, files: string[], opts: { beforeRestore?: boolean } = {}): Promise<Checkpoint | null> {
    try {
      await ensureInit();
      const g = git();
      const isFirst = !(await hasHead(g));
      /* 顺序有讲究：**先 add 再取 diff**。
         空仓库里 `git diff HEAD` 会报"有歧义的参数 'HEAD'"，而 `git diff --cached` 永远可用。
         这份 diff 描述的是**上一次**改动（本函数记的是"动手前"），所以写回上一个快照的元数据。 */
      await R(g, 'add', '-A', '.');
      const staged = await R(g, 'diff', '--cached', '--name-only');
      if (!isFirst && !staged.trim()) return null; // 没变化就不必再记一笔
      const stat = await cachedStat(g);
      await R(g, 'commit', '-q', '-m', label.slice(0, 200) || 'snapshot', '--allow-empty');
      const sha = (await R(g, 'rev-parse', 'HEAD')).trim();
      /* ts 用 meta 里的毫秒时间（git 提交时间只有秒级，同一秒里连打两个快照会并列）。
         "撤回前自动备份"这类由系统打的快照不出现在对外列表里（否则一撤回就多两条噪音） */
      const cp: Checkpoint = {
        id: sha.slice(0, 12),
        sha,
        ts: Date.now(),
        label: label.slice(0, 200),
        files: files.map((f) => rel(cwd, f)).filter(Boolean).slice(0, 40),
        ...(opts.beforeRestore ? { beforeRestore: true } : {}),
      };
      if (!isFirst && stat.files) {
        const prev = await latestMeta(dir);
        if (prev) await writeMeta(dir, prev.id, { ...prev, added: stat.added, removed: stat.removed });
      }
      await writeMeta(dir, cp.id, cp);
      return cp;
    } catch (err) {
      log.warn('打检查点失败（不影响文件写入）', { sessionId, err: String(err) });
      return null;
    }
  }

  /**
   * 恢复到某个快照。
   *
   * 四步，缺一不可：
   *  1. 先把**当前**状态记一笔（撤回也能被撤回，不做单向破坏）；
   *  2. 删掉"在这个快照里不存在"的已跟踪文件 —— 否则"新建了一个文件再撤回"会留下残骸
   *     （checkout 只管把快照里有的文件写回去，不会删多出来的）；
   *  3. 清掉快照之后新增的**未跟踪**文件（`clean -fd`，不含被忽略的 node_modules 之类），
   *     这样"这次改动新建的文件"才真的消失；
   *  4. 把结果**提交成新快照**（而不是 reset）：历史只增不减，刚才那次撤回也留得住。
   */
  async function restore(id: string): Promise<{ ok: boolean; detail: string; files: string[]; removed: string[] }> {
    try {
      await ensureInit();
      const g = git();
      const target = await resolve(g, id);
      if (!target) return { ok: false, detail: `找不到检查点 ${id}（可以列出来看看有哪些）`, files: [], removed: [] };

      await snapshot('撤回前的状态（可再撤回来）', [], { beforeRestore: true });

      const inTarget = new Set(await treePaths(g, target));
      const tracked = await treePaths(g, 'HEAD');
      const removed: string[] = [];
      for (const p of tracked) {
        if (inTarget.has(p)) continue;
        const abs = path.join(cwd, p);
        try {
          fs.rmSync(abs, { force: true });
          removed.push(p);
        } catch {
          /* 删不掉就留着，能让用户看到 */
        }
      }
      await R(g, 'checkout', target, '--', '.');
      // 未跟踪的新文件（clean -n 先列出来，便于如实汇报；-x 不传：被忽略的不动）
      let cleanList = '';
      try {
        cleanList = await R(g, 'clean', '-nd');
      } catch {
        /* ignore */
      }
      try {
        await R(g, 'clean', '-fdq');
      } catch {
        /* ignore */
      }
      for (const line of cleanList.split('\n')) {
        const p = line.replace(/^Would remove\s+/, '').trim();
        if (p) removed.push(rel(cwd, p));
      }
      await R(g, 'add', '-A', '.');
      await R(g, 'commit', '-q', '-m', `restore -> ${target.slice(0, 12)}`, '--allow-empty');
      const detail =
        removed.length > 0
          ? `已恢复到检查点 ${target.slice(0, 12)}；顺带移除 ${removed.length} 个快照之后新增的文件`
          : `已恢复到检查点 ${target.slice(0, 12)}`;
      return { ok: true, detail, files: [...inTarget].slice(0, 40), removed };
    } catch (err) {
      return { ok: false, detail: `撤回失败：${err instanceof Error ? err.message : String(err)}`, files: [], removed: [] };
    }
  }

  async function treePaths(g: SimpleGit, rev: string): Promise<string[]> {
    try {
      const out = await R(g, 'ls-tree', '-r', '--name-only', rev);
      return out.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function resolve(g: SimpleGit, id: string): Promise<string | null> {
    const clean = String(id ?? '').trim();
    if (!clean || !/^[0-9a-f]{4,40}$/i.test(clean)) return null; // 只接受 sha，不做任意 rev 解析（防注入）
    try {
      return (await R(g, 'rev-parse', '--verify', `${clean}^{commit}`)).trim();
    } catch {
      return null;
    }
  }

  async function diff(id?: string) {
    try {
      await ensureInit();
      const g = git();
      if (!(await hasHead(g))) return { text: '', stat: { files: 0, added: 0, removed: 0, list: [] } };
      const target = id ? await resolve(g, id) : (await R(g, 'rev-parse', 'HEAD')).trim();
      if (!target) return { text: '', stat: { files: 0, added: 0, removed: 0, list: [] } };
      /* 先 add 再比 —— 关键在于**新建的文件**：未跟踪文件不会出现在 `git diff HEAD` 里，
         只显示"改了已有文件"，用户会以为新文件没被记录。staged 一次之后索引=工作树，
         后面的 diff 也就等价于"工作树 vs 快照"（与打快照时的口径完全一致）。 */
      await R(g, 'add', '-A', '.');
      const text = await R(g, 'diff', '--cached', '--no-color', target);
      const list = parseList(await R(g, 'diff', '--cached', '--numstat', target));
      const stat = list.reduce(
        (acc, it) => ({ files: acc.files + 1, added: acc.added + it.added, removed: acc.removed + it.removed }),
        { files: 0, added: 0, removed: 0 },
      );
      return { text, stat: { ...stat, list } };
    } catch (err) {
      log.warn('取 diff 失败', { sessionId, err: String(err) });
      return { text: '', stat: { files: 0, added: 0, removed: 0, list: [] } };
    }
  }

  async function hasChanges(): Promise<boolean> {
    try {
      await ensureInit();
      const g = git();
      if (!(await hasHead(g))) return false;
      const out = await R(g, 'status', '--porcelain');
      return out.split('\n').some((l) => {
        const p = l.slice(3).trim();
        return Boolean(p) && !isIgnoredPath(p);
      });
    } catch {
      return false;
    }
  }

  /** 防御：绝不把检查点目录自己算成"改动"（排除规则失效时的兜底） */
  function isIgnoredPath(p: string): boolean {
    const relCp = path.relative(cwd, CHECKPOINTS_DIR);
    return Boolean(relCp) && !relCp.startsWith('..') && p.startsWith(relCp.split(path.sep).join('/'));
  }

  async function list(): Promise<Checkpoint[]> {
    try {
      await ensureInit();
      const g = git();
      if (!(await hasHead(g))) return [];
      const out = await R(g, 'log', '--pretty=format:%H|%ct|%s', '-n', '200');
      const items: Checkpoint[] = [];
      for (const line of out.split('\n')) {
        const [sha, ct, ...rest] = line.split('|');
        if (!sha) continue;
        const id = sha.slice(0, 12);
        const meta = readMeta(dir, id);
        // 系统打的"撤回前备份"不进列表（它已经以 "restore -> x" 的形式体现了，再多一条只是噪音）
        if (meta?.beforeRestore) continue;
        items.push({
          id,
          sha,
          ts: meta?.ts ?? Number(ct) * 1000,
          label: meta?.label ?? rest.join('|'),
          files: meta?.files ?? [],
          ...(meta?.added !== undefined ? { added: meta.added, removed: meta.removed } : {}),
          ...(meta?.beforeRestore ? { beforeRestore: true } : {}),
        });
      }
      return items;
    } catch {
      return [];
    }
  }

  function dispose(): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了，下次同 id 会重建 */
    }
  }

  return { sessionId, cwd, snapshot, restore, diff, hasChanges, list, dispose };
}

/* ────────────────────────── 小工具 ────────────────────────── */

function rel(cwd: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const r = path.relative(cwd, abs);
  return r.startsWith('..') ? abs : r;
}

function parseNumstat(out: string): { files: number; added: number; removed: number } {
  const list = parseList(out);
  return list.reduce(
    (acc, it) => ({ files: acc.files + 1, added: acc.added + it.added, removed: acc.removed + it.removed }),
    { files: 0, added: 0, removed: 0 },
  );
}

function parseList(out: string): Array<{ path: string; added: number; removed: number }> {
  const list: Array<{ path: string; added: number; removed: number }> = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    list.push({
      path: (m[3] ?? '').trim(),
      added: Number(m[1] === '-' ? 0 : m[1]),
      removed: Number(m[2] === '-' ? 0 : m[2]),
    });
  }
  return list;
}

function metaPath(dir: string, id: string): string {
  return path.join(dir, 'meta', `${id}.json`);
}

function writeMeta(dir: string, id: string, data: unknown): void {
  try {
    fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
    fs.writeFileSync(metaPath(dir, id), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    /* 元数据丢了不影响 git 里的快照本身 */
  }
}

function readMeta(dir: string, id: string): Checkpoint | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(dir, id), 'utf8')) as Checkpoint;
  } catch {
    return null;
  }
}

async function latestMeta(dir: string): Promise<Checkpoint | null> {
  try {
    const files = fs.readdirSync(path.join(dir, 'meta')).filter((f) => f.endsWith('.json'));
    let best: Checkpoint | null = null;
    for (const f of files) {
      const m = readMeta(dir, f.replace(/\.json$/, ''));
      if (!m) continue;
      if (!best || m.ts >= best.ts) best = m;
    }
    return best;
  } catch {
    return null;
  }
}

/* ────────────────────────── 对外入口 ────────────────────────── */

/**
 * 取一个会话的检查点仓库。
 *
 * 每条会话一个仓库（而不是全局一个）：会话就是"一次任务"，撤回的范围天然是任务内的；
 * 并发会话写同一个仓库要互相排队，diff 也会串台。
 * 按 (会话, 工作目录) 缓存 —— 同一会话换了项目就是另一棵树，不能共用。
 */
export function repoFor(sessionId: string, cwd: string): CheckpointRepo | null {
  if (!sessionId || !cwd) return null;
  const key = `${sessionId}::${cwd}`;
  if (repos.has(key)) return repos.get(key)!;
  let repo: CheckpointRepo | null = null;
  try {
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
    repo = makeRepo(sessionId, cwd);
  } catch (err) {
    log.warn('初始化检查点仓库失败（撤回功能不可用）', { sessionId, err: String(err) });
  }
  repos.set(key, repo);
  return repo;
}

/** 会话被彻底删除时清掉它的检查点仓库 */
export function forgetRepo(sessionId: string): void {
  for (const [key, repo] of repos) {
    if (key.startsWith(`${sessionId}::`)) {
      repo?.dispose();
      repos.delete(key);
    }
  }
}
