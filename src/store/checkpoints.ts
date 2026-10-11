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
import { readSettings } from './settings.ts';

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

/** diff 里的一行（`-` 删 / `+` 增 / ` ` 上下文；\ No newline 这类元信息行不进这里） */
export type DiffLine = {
  /** old/new 行号（该侧没有就是 null —— 新增行没有旧行号，删除行没有新行号） */
  oldNo: number | null;
  newNo: number | null;
  kind: 'add' | 'del' | 'ctx';
  text: string;
};

/** 一个文件的 diff（GitHub 那种按文件分组的呈现） */
export type DiffFile = {
  /** 相对工作目录的路径（重命名时是"新名字"） */
  path: string;
  /** 旧路径（只有重命名/复制才有） */
  oldPath?: string;
  added: number;
  removed: number;
  /** 二进制文件：没有逐行内容 */
  binary: boolean;
  lines: DiffLine[];
};

export type DiffResult = {
  /** 纯文本 diff（统一格式，带 --unified=3），命令行工具与"复制"仍可用 */
  text: string;
  stat: { files: number; added: number; removed: number; list: Array<{ path: string; added: number; removed: number }> };
  /** 结构化逐行数据：界面据此渲染行号、增删底色、按文件折叠 */
  files: DiffFile[];
};

export type CheckpointRepo = {
  sessionId: string;
  cwd: string;
  /** 打一个"改动前"快照；内容没变时返回 null */
  snapshot: (label: string, files: string[], opts?: { beforeRestore?: boolean }) => Promise<Checkpoint | null>;
  /** 把工作树恢复到某个快照 */
  restore: (id: string) => Promise<{ ok: boolean; detail: string; files: string[]; removed: string[] }>;
  /** 当前工作树相对最新快照的改动 */
  diff: (id?: string) => Promise<DiffResult>;
  /** 有没有未快照的改动 */
  hasChanges: () => Promise<boolean>;
  /**
   * 某个检查点之后改了什么（与下一个检查点比；最新的那条与当前工作树比）。
   *
   * `files` 是**结构化**的逐行数据（GitHub 风格并排/统一视图都靠它）：
   * 界面不再自己解析 diff 文本，行号、增删、折叠区间都由服务端算好。
   * `text` 仍然返回（纯文本，给命令行工具与"复制"用）。
   */
  show: (id: string, file?: string) => Promise<DiffResult>;
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

  /** 本会话累计"动过的路径"的内存副本（元数据是持久层，这里是热路径的缓存） */
  let latestTouched: string[] | null = null;

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
      /* **只把"这次要动的路径"同步进索引，绝不做 `add -A .`**。
         这一条是踩出来的：会话没绑项目时 cwd 就是家目录，`git add -A .` 会把几十万个文件
         逐个 stat 一遍 —— 一次 write_file 就能卡住几十秒，整个循环跟着停摆（e2e 里表现为超时）。
         没有可用的路径范围时宁可**不记**这一笔，也不扫全树。 */
      const declared = scopeOf(cwd, files);
      /* 没申报路径时（系统快照，如"撤回前备份"）退回"本会话动过的路径 + 索引里已有的路径"：
         两处都是有界的，绝不退化成全树扫描。 */
      const scope = declared.length ? declared : await scopeFor(g, []);
      if (!scope.length) {
        log.warn('快照缺少路径范围，已跳过（不做全树扫描）', { sessionId, label });
        return null;
      }
      const isFirst = !(await hasHead(g));
      /* 顺序有讲究：**先 add 再取 diff**。
         空仓库里 `git diff HEAD` 会报"有歧义的参数 'HEAD'"，而 `git diff --cached` 永远可用。
         这份 diff 描述的是**上一次**改动（本函数记的是"动手前"），所以写回上一个快照的元数据。 */
      /* 申报的路径**无条件记下来**（与"这次有没有产生新快照"无关）：
         文件真建出来之后是未跟踪文件，git 的索引与快照树里都没有它，
         只有这份清单能让 diff/撤回知道该看它。 */
      mergeTouched(scope);
      /* 第三个参数是"申报过的路径"：被忽略目录里的文件靠它才进得了索引（见 stagePaths 注释） */
      await stagePaths(g, scope, [...declared, ...readTouched()]);
      const staged = await R(g, 'diff', '--cached', '--name-only');
      /* 空仓库时**即使没有内容也要建第一个提交**：这样 HEAD 立刻存在，
         之后"新建的文件"才有可比对的基准（否则 diff 会因为"没有 HEAD"返回空）。
         有 HEAD 之后，内容没变化就不必再记一笔（典型：要新建的文件此刻还不存在）。 */
      if (!isFirst && !staged.trim()) return null;
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
        files: scope.slice(0, 40),
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

      /* 撤回前先把当前状态记一笔（撤回也能被撤回）。
         这里**不传路径**（系统快照没有"要动的文件"）—— 范围由 snapshot 自己从
         "动过的路径 + 索引"里取，不做全树扫描。 */
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
      /* 只 checkout 目标快照里**确实存在**的路径：快照可能是空树（"新建文件"那一笔就是），
         此时 `checkout <sha> -- .` 会 fatal（"路径规格 '.' 未匹配任何 Git 已知文件"）。 */
      const inTargetList = [...inTarget];
      if (inTargetList.length) await R(g, 'checkout', target, '--', ...inTargetList.slice(0, 400));
      /* 未跟踪的新文件：`clean -fdq` 清掉它们（不传 -x：被忽略的 node_modules 之类不动）。
         清单**用 `ls-files --others --exclude-standard` 拿**，不用 `clean -n` ——
         后者的输出是本地化的（中文环境里是"将删除 xxx"），按前缀解析会漏掉（实测踩过）。
         范围仍然有界：只问"本会话动过的路径 + 快照里的路径"里有没有未跟踪文件。 */
      let cleanList = '';
      try {
        const dirs = [...new Set([...inTarget, ...tracked, ...readTouched()])];
        if (dirs.length) cleanList = await R(g, 'ls-files', '--others', '--exclude-standard', '--', ...dirs.slice(0, 400));
      } catch {
        /* ignore */
      }
      try {
        await R(g, 'clean', '-fdq', '--', ...(await scopeFor(g, [...inTarget])).slice(0, 400));
      } catch {
        /* ignore */
      }
      for (const line of cleanList.split('\n')) {
        const p = line.trim();
        if (p) removed.push(rel(cwd, p));
      }
      /* 索引对齐工作树：范围 = 目标快照里的路径 ∪ 索引里已有的路径 ∪ 本会话动过的路径
         （都不需要扫工作树） */
      await stagePaths(g, await scopeFor(g, [...inTarget, ...tracked]), readTouched());
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

  /** 索引里已跟踪的路径（`ls-files` 只读索引，不碰工作树 —— 毫秒级） */
  async function trackedPaths(g: SimpleGit): Promise<string[]> {
    try {
      const out = await R(g, 'ls-files');
      return out.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * "这次快照要管的路径" = 本次申报的路径 ∪ 本会话历史上被改动过的路径 ∪ 索引里已有的路径。
   *
   * 中段那份清单是给**新建的未跟踪文件**用的：它不在索引里、也不在任何快照树里，
   * 只看 git 的这两处信息来源会完全看不见它（diff 为空，用户以为没记上）。
   * 清单是工具申报出来的，有界（不是扫描结果）。
   */
  async function scopeFor(g: SimpleGit, extra: string[]): Promise<string[]> {
    return [...new Set([...extra, ...readTouched(), ...(await trackedPaths(g))])];
  }

  /**
   * 累计"动过的路径"（有上限，新的优先）。
   *
   * 存成会话级独立文件（`touched.json`），**不挂在某笔快照的元数据上** ——
   * 踩过的坑：挂元数据时，会话里"第一次新建文件"这一笔因为内容没变化不产生新快照，
   * 清单就丢了，之后 diff/撤回完全看不见这个新文件（最常见的新建场景直接失效）。
   */
  function mergeTouched(scope: string[]): string[] {
    const out = [...new Set([...scope, ...readTouched()])].slice(0, TOUCHED_MAX);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'touched.json'), `${JSON.stringify(out)}\n`, 'utf8');
    } catch {
      /* 记不住就退化成"只看 git 已知的路径"，不影响写文件 */
    }
    return out;
  }

  function readTouched(): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'touched.json'), 'utf8')) as unknown;
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * 把一批路径同步进索引。
   *
   * 四个必须绕开的坑（全部实测过）：
   *  · **绝不退化成 `add -A .`**：cwd 可能是家目录，全树扫描会把循环卡死 ——
   *    范围永远来自"申报过的路径"，有界；
   *  · **被忽略的路径会让 `add` 整体失败**（"下列路径根据您的一个 .gitignore 文件而被忽略"，
   *    exit=1，**这一批里其它路径也不会进索引**）。影子仓库自带忽略清单（`node_modules/`、
   *    `out/`、`*.log`…），而 agent 亲写的文件恰恰可能落在里面 —— 于是 diff 里完全看不见，
   *    用户以为没记上（实测：写 `out/note.txt` 后面板空空如也）。
   *    两条对策：① 申报过的普通小文件用 `git add -f` 强制进索引（覆盖 excludesFile 与项目
   *    自己的 .gitignore）；② 剩下的先问 `check-ignore` 剔掉。检查点目录自己与 `.git` 永不强制；
   *  · **`check-ignore` 会把"已跟踪"的文件也报成忽略**（实测 exit=0），所以问之前先排掉已跟踪的，
   *    否则会把正常文件误剔；
   *  · **已跟踪但已被删除的路径，`add -A` 也会失败**（"路径规格未匹配任何文件"/被忽略提示），
   *    而"删除文件"正是要记的改动。这类走 `update-index --force-remove`：只动索引、不碰工作树。
   */
  async function stagePaths(g: SimpleGit, scope: string[], declared: string[] = []): Promise<void> {
    if (!scope.length) return;
    const tracked = new Set(await trackedPaths(g));
    const present: string[] = [];
    const goneTracked: string[] = [];
    for (const p of scope) {
      if (fs.existsSync(path.join(cwd, p))) present.push(p);
      else if (tracked.has(p)) goneTracked.push(p);
    }
    /* 强制的先算出来（在忽略过滤**之前**）：被忽略的路径恰恰是它要救的那批 */
    const force = new Set(forceCandidates(present, declared, tracked));
    const ignored = await ignoredPaths(g, present.filter((p) => !tracked.has(p) && !force.has(p)));
    const plain = present.filter((p) => !force.has(p) && (!ignored.has(p) || tracked.has(p)));
    const forced = present.filter((p) => force.has(p));
    /* 分批：路径太多时命令行会超长（这个上限远高于任何一次工具调用的规模） */
    await stagedBatch(g, ['add', '-A'], plain);
    await stagedBatch(g, ['add', '-f', '-A'], forced);
    await stagedBatch(g, ['update-index', '--force-remove'], goneTracked);
  }

  /**
   * 一批一批地写索引；**某一条路径让整批失败时退化成逐条重试**。
   *
   * 为什么必须兜底：忽略清单是我们自己给的（`check-ignore`），但它可能问不全 ——
   * 项目自带的 `.gitignore` 嵌套在子目录里、或者路径是符号链接指向被忽略处，
   * 都会让一条坏路径把**整批**拖垮（git add 是"全成功或全失败"），
   * 结果这一笔快照整个丢失（用户看到"没记上"）。逐条重试只牺牲那一条。
   */
  async function stagedBatch(g: SimpleGit, args: string[], paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 200) {
      const batch = paths.slice(i, i + 200);
      if (!batch.length) continue;
      try {
        await R(g, ...args, '--', ...batch);
      } catch {
        for (const p of batch) {
          try {
            await R(g, ...args, '--', p);
          } catch {
            /* 单条也不行就算了：它不该拖垮其它路径 */
          }
        }
      }
    }
  }

  /**
   * "该不该强制跟踪"：本次申报 ∩ 存在于工作树 ∩ 还没被跟踪 ∩ 普通文件 ∩ 体积不夸张。
   *
   * 体积上限是为了守住"影子仓库要小"：`write_file` 可能写出一份大文本，
   * 但一次工具调用的产物不该让每笔快照都背上它。
   */
  function forceCandidates(existing: string[], declared: string[], tracked: Set<string>): string[] {
    if (!declared.length) return [];
    const want = new Set(declared.map((p) => rel(cwd, p)));
    const out: string[] = [];
    for (const p of existing) {
      if (!want.has(p) || tracked.has(p) || !forceAllowed(cwd, p)) continue;
      try {
        const st = fs.statSync(path.join(cwd, p));
        if (!st.isFile() || st.size > FORCE_MAX_BYTES) continue;
      } catch {
        continue;
      }
      out.push(p);
    }
    return out;
  }

  async function ignoredPaths(g: SimpleGit, paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    try {
      const out = await R(g, 'check-ignore', '--', ...paths.slice(0, 500));
      return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
    } catch {
      /* 一个都没被忽略时 check-ignore 返回非零，这里当成"没有忽略项" */
      return new Set();
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

  /**
   * 某个检查点**之后**改了什么（这个检查点 → 下一个检查点）。
   *
   * 为什么是"往后看"而不是"往前看"：快照记的是**动手前**的样子，
   * 它的原因写在自己的标签里（"edit_file notes/todo.md"），
   * 那么"这次改动改了什么"就是它与**下一个**快照的差异 —— 标签、行数、diff 三者才对得上。
   * （刚打的新快照还没有下一个：退回用"工作树 vs 它"，即当前状态。）
   */
  async function show(id: string, file?: string): Promise<DiffResult> {
    const empty: DiffResult = { text: '', stat: { files: 0, added: 0, removed: 0, list: [] }, files: [] };
    try {
      await ensureInit();
      const g = git();
      const target = await resolve(g, id);
      if (!target) return empty;
      const order = (await R(g, 'log', '--pretty=format:%H', '-n', '300')).split('\n').map((s) => s.trim()).filter(Boolean);
      const idx = order.indexOf(target);
      if (idx < 0) return empty;
      // order 是"新→旧"，所以下一个（更晚的）快照是 idx-1；idx=0 表示它已经是最新的
      const next = idx > 0 ? order[idx - 1]! : '';
      const pathspec = file ? ['--', rel(cwd, file)] : [];
      /* 最新那条（还没有"下一个快照"）：要跟**当前工作树**比。
         新建的未跟踪文件不会出现在 `git diff <sha>` 里，所以先把"这次改动涉及的路径"
         同步进索引再比 —— 范围来自索引 + 快照树，不做全树扫描（见 stagePaths 的说明）。 */
      if (!next) await stagePaths(g, await scopeFor(g, await treePaths(g, target)), readTouched());
      const diffArgs = next ? [target, next] : ['--cached', target];
      return await collectDiff(g, diffArgs, pathspec);
    } catch (err) {
      log.warn('取检查点 diff 失败', { sessionId, id, err: String(err) });
      return empty;
    }
  }

  async function diff(id?: string): Promise<DiffResult> {
    const empty: DiffResult = { text: '', stat: { files: 0, added: 0, removed: 0, list: [] }, files: [] };
    try {
      await ensureInit();
      const g = git();
      if (!(await hasHead(g))) return empty;
      const target = id ? await resolve(g, id) : (await R(g, 'rev-parse', 'HEAD')).trim();
      if (!target) return empty;
      /* 先同步索引再比 —— 关键在于**新建的文件**：未跟踪文件不会出现在 `git diff HEAD` 里，
         只显示"改了已有文件"，用户会以为新文件没被记录。
         范围 = 快照树里的路径 ∪ 索引里已有的路径（两次都只读索引/树，不扫工作树）。 */
      await stagePaths(g, await scopeFor(g, await treePaths(g, target)), readTouched());
      return await collectDiff(g, ['--cached', target], []);
    } catch (err) {
      log.warn('取 diff 失败', { sessionId, err: String(err) });
      return empty;
    }
  }

  /**
   * 一次取齐"纯文本 + 结构化 + 统计"。
   *
   * `--unified=3` 显式写死：默认值就是 3，但不依赖默认值 —— 用户可能在 ~/.gitconfig
   * 里设了 `diff.context`，那会让折叠区间与别人的不一致（这里的影子仓库不读全局配置，
   * 但显式传更保险，也把"界面每次折叠 3 行"这件事写死在协议里）。
   */
  async function collectDiff(g: SimpleGit, diffArgs: string[], pathspec: string[]): Promise<DiffResult> {
    const text = await R(g, 'diff', '--no-color', '--no-ext-diff', '--unified=3', ...diffArgs, ...pathspec);
    const list = parseList(await R(g, 'diff', '--numstat', '--no-ext-diff', ...diffArgs, ...pathspec));
    const stat = list.reduce(
      (acc, it) => ({ files: acc.files + 1, added: acc.added + it.added, removed: acc.removed + it.removed }),
      { files: 0, added: 0, removed: 0 },
    );
    return { text, stat: { ...stat, list }, files: parseUnifiedDiff(text) };
  }

  async function hasChanges(): Promise<boolean> {
    try {
      await ensureInit();
      const g = git();
      if (!(await hasHead(g))) return false;
      const out = await R(g, 'status', '--porcelain');
      if (
        out.split('\n').some((l) => {
          const p = l.slice(3).trim();
          return Boolean(p) && !isIgnoredPath(p);
        })
      ) {
        return true;
      }
      /* `status --porcelain` 看不见**被忽略**的未跟踪文件，而 agent 亲写的文件可能就在
         忽略目录里（`out/`、`dist/`…）。用"申报过的路径里有没有索引还不认识的文件"补齐 ——
         范围来自清单，有界，不做全树扫描。 */
      const tracked = new Set(await trackedPaths(g));
      return readTouched().some((p) => {
        if (tracked.has(p) || !forceAllowed(cwd, p)) return false;
        try {
          return fs.statSync(path.join(cwd, p)).isFile();
        } catch {
          return false;
        }
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
      /* 列表窗口条数来自系统参数（设置 → 系统 → checkpointLimit），**不是硬编码**：
         0 = 不限制（列出全部）。检查点本身不会因为超限被删（都在 dir 里），
         被截掉的只是列表接口返回的条数。 */
      const limit = Math.trunc(Number(readSettings().system.checkpointLimit ?? 200));
      const args = ['log', '--pretty=format:%H|%ct|%s'];
      if (Number.isFinite(limit) && limit > 0) args.push('-n', String(limit));
      const out = await R(g, ...args);
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
      /* 最新那一条的增删行数**永远填不上**（它靠"下一笔快照"回填，而它就是最后一笔）。
         于是刚改完文件时面板会显示 +0−0，看起来像"没改动"——用户会以为没记上。
         这里用现成的 show()（工作树 vs 它）给最新一条补算，口径与点开看的 diff 完全一致。 */
      const head = items[0];
      if (head && head.added === undefined) {
        const s = await show(head.id);
        if (s.stat.files) {
          head.added = s.stat.added;
          head.removed = s.stat.removed;
        }
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

  return { sessionId, cwd, snapshot, restore, diff, show, hasChanges, list, dispose };
}

/* ────────────────────────── 小工具 ────────────────────────── */

function rel(cwd: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const r = path.relative(cwd, abs);
  return r.startsWith('..') ? abs : r;
}

/**
 * 一次改动涉及的工作目录相对路径（快照的作用范围）。
 *
 * 传入的是绝对路径（工具的 resolve 结果）。落在工作目录**之外**的路径直接丢弃：
 * 影子仓库的 work-tree 就是工作目录，外面的文件 git 管不着，
 * 混进来只会让 `git add` 报"路径在仓库外"。
 * 一个都没有时返回空数组 —— 调用方据此跳过这次快照，而不是退化成全树扫描。
 */
function scopeOf(cwd: string, files: string[]): string[] {
  const out: string[] = [];
  for (const f of files ?? []) {
    if (!f) continue;
    const r = rel(cwd, String(f));
    if (!r || r.startsWith('..') || path.isAbsolute(r)) continue;
    out.push(r);
  }
  return [...new Set(out)];
}

/** "动过的路径"清单的上限：够用（远超一次工具调用）又不会让元数据无限膨胀 */
const TOUCHED_MAX = 400;

/** 强制跟踪单个文件的大小上限（影子仓库要小；再大的东西是产物，不是"改动"） */
const FORCE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 哪些路径**永远不许**强制跟踪：影子仓库自己、`.git`。
 *
 * 这两处一旦进了索引，快照就会自我引用（git 目录里的内容每次都在变），仓库会失控。
 */
function forceAllowed(cwd: string, p: string): boolean {
  const r = rel(cwd, p).split(path.sep).join('/');
  if (!r || r.startsWith('..')) return false;
  if (r.split('/').includes('.git')) return false;
  const relCp = path.relative(cwd, CHECKPOINTS_DIR).split(path.sep).join('/');
  if (relCp && !relCp.startsWith('..') && (r === relCp || r.startsWith(`${relCp}/`))) return false;
  return true;
}

function parseNumstat(out: string): { files: number; added: number; removed: number } {
  const list = parseList(out);
  return list.reduce(
    (acc, it) => ({ files: acc.files + 1, added: acc.added + it.added, removed: acc.removed + it.removed }),
    { files: 0, added: 0, removed: 0 },
  );
}

/**
 * 统一 diff 文本 → 结构化逐行数据（界面的 GitHub 风格视图靠它）。
 *
 * 为什么不在前端解析：diff 的边界情况都在细节里（`\ No newline at end of file`、
 * 重命名只有 `--- a/old` `+++ b/new`、二进制文件只有一句 `Binary files … differ`、
 * 路径里带空格与引号、hunk 头的 `@@ -1,2 +3,4 @@` 里计数可省略）。
 * 放服务端解析一次，前端只管画 —— 并且和 `text` 是同一份 diff，不会两边不一致。
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  /** 只在 hunk 里认内容行：`diff` 头与文件头之间的空行不能被当成上下文 */
  let inHunk = false;
  const lines = String(text ?? '').split('\n');
  /* 去掉末尾那个空串：`"a\n"` 分割出来是 `['a','']`，那个 '' 是换行符的残影，
     不是文件里的一行 —— 不删就会在 diff 末尾多出一条 newNo 越界的假上下文行。 */
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      // 新文件块开始。路径以头部为准，`---`/`+++` 只用来补重命名
      const m = /^diff --git (.+) (.+)$/.exec(line);
      cur = { path: unquoteGitPath(m?.[2] ?? ''), added: 0, removed: 0, binary: false, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue; // 头部的杂项（git 版本之类的噪声）直接丢
    if (line.startsWith('index ') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity index')) continue;
    if (line.startsWith('new file mode')) continue;
    if (line.startsWith('deleted file mode')) continue;
    if (line.startsWith('rename from ')) {
      cur.oldPath = unquoteGitPath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.path = unquoteGitPath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = unquoteGitPath(line.slice(4));
      if (p === '/dev/null') cur.oldPath = undefined;
      else if (!cur.oldPath) cur.oldPath = stripAbPrefix(p);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = unquoteGitPath(line.slice(4));
      if (p !== '/dev/null') cur.path = stripAbPrefix(p);
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      // `@@ -a,b +c,d @@`；计数可省略，默认 1
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      inHunk = true;
      continue;
    }
    if (line.startsWith('\\')) continue; // `\ No newline at end of file`：元信息，不占行
    if (!inHunk) continue;
    // 内容行：三种前缀都要当"有内容"处理（空行是 ` ` 或 `+`/`-` 后面什么都没有）
    if (line.startsWith('+')) {
      cur.lines.push({ oldNo: null, newNo: newNo++, kind: 'add', text: line.slice(1) });
      cur.added += 1;
      continue;
    }
    if (line.startsWith('-')) {
      cur.lines.push({ oldNo: oldNo++, newNo: null, kind: 'del', text: line.slice(1) });
      cur.removed += 1;
      continue;
    }
    if (line.startsWith(' ') || line === '') {
      cur.lines.push({ oldNo: oldNo++, newNo: newNo++, kind: 'ctx', text: line.slice(1) });
    }
  }
  /* `--- a/x` / `+++ b/x` 在**普通修改**里也是成对出现的，别把同名的两行当成重命名 ——
     否则界面会显示"x → x"，看着像出了错。只有真不一样才留 oldPath。 */
  for (const f of files) {
    if (f.oldPath === f.path) delete f.oldPath;
  }
  return files;
}

/** git 里带特殊字符的路径会整体加双引号并转义 —— 这里的路径用于显示与 `--` 匹配，去掉引号即可 */
function unquoteGitPath(p: string): string {
  const s = p.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

function stripAbPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
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
