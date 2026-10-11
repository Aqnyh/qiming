# 启明（Qiming）架构设计

独立的本机智能体工程。不依赖文档站、不依赖旧 agent 代码，后端 **TypeScript（Node 22 原生类型剥离，零构建）**，
前端 **React 19 + esbuild + Tailwind 4**。数据全部落在工程内的 `data/`。

## 一、设计目标（来自需求）

1. **独立**：workspace 下单独文件夹，自己的端口与生命周期，不随文档站启动。
2. **无账号体系 / 权限最大化**：登录即本机账号登录（用户名 = 服务进程的 OS 用户，密码用 `sudo` 校验）；
   登录后命令以本机身份执行，可自由用 `sudo`；没有访问级别、没有工具白名单。
3. **四个模块**：插件（提示词 + 可执行命令）、记忆（工作记录）、技能（工作方法）、外部资源（可调用的外部能力）。
4. **执行模型**：前端只发请求；后端自行开循环；多会话 = 多循环并行；客户端可随时关掉，运行继续。
5. **thinking 与操作明细不进客户端内存**：事件流只发摘要/计数，展开时按 `(runId, seq)` 从服务端取全文。

## 二、目录

```
qiming/
  server.ts              入口（HTTP + 静态 + API + SSE 挂载）
  src/
    server/http.ts       路由/JSON/SSE/静态资源/请求体
    server/api.ts        全部 API 端点（唯一路由表）
    server/runs.ts       运行注册表：多会话并发、插话、停止、事件订阅
    server/runner.ts     运行宿主：组装→循环→落盘→事件；含事件/运行日志存储
    agent/loop.ts        循环内核（与传输无关，只依赖注入的 provider 与 toolRun）
    agent/rounds.ts      轮次上限的唯一判定处（主运行 + 子智能体，纯函数，单测钉住）
    agent/prompt.ts      系统提示词组装（插件/记忆/技能/资源 → system 块）
    agent/context.ts     token 估算、压缩、请求视图
    agent/tools.ts       工具登记与执行（插件/记忆/技能/资源/子智能体统一入口）
    agent/subagent.ts    子智能体（复用 loop，独立预算与工具集）
    providers/*.ts       openai / anthropic 适配器、SSE 解析、think 切分、正文型工具调用
    modules/plugins/     插件登记表 + 内置插件 + 参数
    modules/memory/      记忆（全局/项目/会话）+ 记忆工具
    modules/skills/      技能（SKILL.md 目录）+ 技能工具
    modules/resources/   外部资源登记表 + MCP 客户端 + resource_* 工具
    modules/prompts/     提示词注册中心（默认值 + 用户覆盖）
    store/*.ts           原子读写、会话、项目、设置
    util/*.ts            日志、路径
  ui/                    React 源码（features/ state/ lib/）
  public/                构建产物
  resources/             外部资源本地脚本（如 browser-use 的 runner）
  data/                  运行数据（会话/项目/记忆/技能/设置/运行日志）
  test/                  node:test 单测 + 真机检查脚本
```

## 三、核心数据流

```
浏览器 ──POST /api/chat {sessionId?, projectId?, text}──▶ 运行注册表
                                                        │  同一会话已在跑 → 作为插话注入下一轮
                                                        ▼
                                             runner（每会话一份循环，互不阻塞）
   ┌────────────────────────────────────────────────────────────────┐
   │ 1 组装提示词  prompt.assemble(插件/记忆/技能/资源/项目)          │
   │ 2 上下文视图  context.view(msgs)  （超限则压缩，压缩文走同一份）  │
   │ 3 调模型      providers.chat(stream) ──▶ thinking/content/calls  │
   │ 4 落盘        assistant 消息（正文 + thinking 全文 + 调用记录）    │
   │ 5 广播        SSE 只发：正文增量、思考预览、调用摘要、计数          │
   │ 6 执行操作    tools.run()（插件命令 / 记忆 / 技能 / 资源 / 子体）  │
   │ 7 回填        工具结果作为消息回灌 → 回到 2                       │
   └────────────────────────────────────────────────────────────────┘
              客户端展开某条 → GET /api/run/<runId>/call/<seq> 取全文
```

**客户端不持有明细**：SSE 的 `thinking_delta` 客户端只留最后 ~400 字做实时预览；
`call_*` 事件只有 `argsDigest/digest/chars`。全文（thinking、工具参数、工具结果）存服务端
`data/runs/<runId>/`，点击时按需拉取。刷新页面后同样如此。

## 四、循环（agent/loop.ts）

- 单轮：`provider.chat()` 流式返回 → 解析工具调用（结构化 `tool_calls` 或正文型 DSML）→ 执行 → 回灌。
- 守卫（移植旧项目验证过的）：截断保护（`stop==='length'`/参数损坏不执行只回话）、
  空回答守卫、重复工具调用守卫（只拦成功过的写类空转）、轮次上限、思考死循环检测、上游错误重试。
- 预算：每个插件自带参数（如命令条数、等待次数）；用户设多少就是多少，**服务端不设硬上限**。
- 轮次上限（`src/agent/rounds.ts` 是**唯一判定处**）：
  · 用户在「设置 → 模型与参数」填的 `maxRounds`（`0` = 自动）→ 用多少就是多少，**没有硬封顶**；
  · 自动 = 各启用插件 `max_calls` 之和 + 2（"够把所有插件的额度用光"）；
  · 子智能体另有一套：工具入参 `max_rounds` → 设置里的 `subagentMaxRounds` → 插件参数 → 内置 12。
  曾经这里写过"服务端封 200"、也真的静默封过顶 —— 用户填 300 实际只跑 200 且不报错，
  所以现在把规则收到一个纯函数里、单测直接钉住。真跑飞了用界面上的「停止」中断。
- 插话/排队：见「八之三」「八之十」—— 运行中收到同一会话的新消息**先进队列**，
  按 `steer`（安全点注入）/ `urgent`（掐当前调用）/ `queue`（这一段之后）三种语义兑现。

## 五、四个模块

| 模块 | 是什么 | 存储 | 注入模型的方式 |
|---|---|---|---|
| **插件** | 提示词 + 可执行命令（工具） | 代码内置定义 + `data/plugins.json`（启停、提示词覆盖、参数值） | 提示词块（用法）+ 工具 schema |
| **记忆** | AI 工作的重要记录 | `data/memory/`（全局）、`data/projects/<id>/memory/`（项目） | 索引常驻（标题+摘要），全文按需 `memory_read` |
| **技能** | AI 工作的具体方法（SKILL.md） | `data/skills/<name>/SKILL.md` | 目录（name+description）常驻，`use_skill` 载入全文 |
| **外部资源** | 可通过插件命令调用的外部能力 | `data/resources.json` | 资源目录 + 其暴露的工具/调用方式 |

**模块边界与归属（2026-10-10 第二轮定稿）**：

- 外部资源的工具进**模型工具表**，但**不进界面上的「插件」页**（`PluginDef.external = true`，
  `plugins.views()` 过滤掉）。界面上"插件"与"外部资源"是两个概念，各有一页。
- **提示词单一真源**：`data/prompts.json` 只此一处存覆盖。插件页改用法说明、资源页改说明、
  记忆/技能页改注入语，走的都是 `prompts.set(<条目id>)` —— 与提示词页完全等价。
  条目 id 约定：`system.*` / `loop.*` / `memory.*` / `skills.*` / `compact.*` /
  `plugin.<插件id>.usage` / `tool.<工具名>.desc` / `res.<资源id>.usage`；界面按 group 分组
  （`plugin:<id>`、`res:<id>`、`memory`、`skills`…）。plugins.json **不再存提示词副本**。
- **参数跟着模块走**：插件的参数在 `plugins.json`，外部资源的参数在 `resources.json`
  （`PluginDef.readParams` 让工具执行层统一读到，避免两处各存一份）。

**文件热加载（需求 3"agent 直接改文件来新增/修改"）**：`src/store/watch.ts` 每 2 秒 stat
`plugins.json` / `resources.json` / `prompts.json`，变化后调用各自的 `reload()`。
两条防呆：刚写过（<1.5s）的跳过这一轮；解析失败**保留内存旧状态**（用 `readJsonStrict`，
不会像启动路径那样把坏文件换成空默认值）。

外部资源三形态：
- `mcp`：stdio MCP 服务器（JSON-RPC），`initialize`/`tools/list`/`tools/call`，工具自动暴露给模型。
  - 浏览器操作 = **browser-use**（`resources/browser-use/`，Python 库 + 本机 OpenAI 兼容端点）
  - 屏幕操作 = **computer-use-linux**（`npx @agent-sh/computer-use-linux mcp`，AT-SPI 语义选择器，Wayland/X11 均可）
- `http`：声明式端点（如 ComfyUI `http://127.0.0.1:8188`），`resource_call` 按动作名调用。
- `command`：本地命令模板，参数走 JSON（stdin），结果读 stdout。

## 六、数据格式

```
data/
  settings.json         {providers:[{id,name,type,baseUrl,apiKey,model,ctxLimit,...}], activeId, params, ui}
  sessions.json         {version, sessions:[Session]}   # 会话（含消息、调用摘要、压缩段）
  projects.json         {version, current, projects:[{id,root,name,created,updated}]}
  prompts.json          {overrides:{<id>:{text?,enabled?}}, updatedAt}
  plugins.json          {plugins:{<id>:{enabled?,prompt?,params?:{<k>:v}}}, updatedAt}
  skills.json           {skills:{<name>:{enabled}}, updatedAt}   # 技能正文在 data/skills/
  resources.json        {resources:[Resource], updatedAt}
  memory/               MEMORY.md + <slug>.md（全局记忆）
  projects/<id>/memory/ MEMORY.md + <slug>.md（项目记忆）
  skills/<name>/        SKILL.md（+ scripts/ references/）
  runs/<runId>/         events.jsonl（事件日志）、calls/<seq>.json（工具全文）、thinking/<msgId>.md
                        、spills/<seq>-<工具>.txt（超长工具结果落盘）
  archives/             会话归档
```

会话历史的**唯一真源**是 `session.log`（append-only 事件日志，见 `store/session-log.ts`）；
`session.msgs` 是它的**派生物**（`deriveMessages`），任何时刻可由日志重建。旧存档没有 log 时，
读入自动反向补一份，行为与旧版逐条一致。

记忆文件格式（与 ZCode/旧项目兼容，可直接拷）：

```markdown
---
name: <slug>
description: <一句话>
metadata:
  type: project
---
正文
```

`MEMORY.md` 是索引：`- [标题](memory/文件.md) — 摘要`。

会话（`sessions.json` 的 Session）：

```ts
{
  id, title, ts, updatedAt, projectId, providerId, model,
  msgs: [{
    id, role, content, ts, thinking?: string,           // thinking 全文（服务端）
    calls?: [{ seq, name, label, argsDigest, state, ms, digest, chars, lines? }],
    stats?: { in, out, ms }, error?
  }],
  compact?: { upTo, count, text, ts }
}
```

## 七、API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth` | 本机账号登录（密码用 `sudo -S -k -v` 校验），成功后发会话令牌 |
| GET | `/api/auth` | 登录状态 |
| GET | `/api/bootstrap` | 启动快照：设置/项目/会话列表/插件/记忆索引/技能/资源（一次拉齐） |
| GET/POST | `/api/sessions` … | 会话增删改查、归档 |
| POST | `/api/chat` | 发消息（带 `sessionId`/`projectId`）；会话在跑 → 插话 |
| POST | `/api/run/stop` | 停止某会话的运行 |
| GET | `/api/events` | SSE：全部运行的事件（带 `runId/sessionId`），先回放再续播 |
| GET | `/api/run/<runId>/call/<seq>` | 取某次工具调用的完整参数与结果 |
| POST | `/api/session/<id>/call/<seq>/undo` | 撤销某次文件改动（按运行日志恢复） |
| GET/POST | `/api/plugins` `/api/memory` `/api/skills` `/api/resources` `/api/prompts` | 四个模块的读写 |
| GET/POST | `/api/settings` | 服务商、参数 |

## 八、子智能体（spawn_agent）

参照主流做法（Claude Code 的 Task / Codex 的子代理）：

- **独立上下文**：主会话历史不带过去，只带一段交办说明（目标 + 已知信息 + 期望结论形式）；
- **独立运行**：有自己的 runId、自己的预算与轮次上限。轮次优先级（`resolveSubRounds`）：
  工具入参 `max_rounds` → 设置里的 `subagentMaxRounds`（界面可改）→ 插件参数 `max_rounds`
  → 内置 12（下限 2）。**没有硬封顶**，填多少跑多少。
  事件照常广播（界面里能单独展开它的转录），但**不写用户会话**（临时会话，只在内存）；
- **默认继承工具、但拿不到 spawn_agent**（不递归，防止套娃失控）；
  `read_only=true` 时只给读类工具；
- **只回传结论**：主循环收到的是它的最终汇报，过程留在它自己的运行日志里。

## 八之二、工作区与项目

- **工作区**（`settings.workspace`，默认 `~/workspace` 的上一级，可在「设置 → 项目」改）：放项目的根目录。
- **一切项目都在工作区之下**：`POST /api/projects`、`POST /api/projects/<id>`（改路径）与
  `GET /api/browse` 三处都校验（用 `path.relative` 判定，`/a/bc` 不会被误判为在 `/a/b` 内）；
  目录选择器到工作区根就返回 `parent: null`，点不出去。
- 项目可改名/改路径；改路径不搬动磁盘文件，只改"会话的默认 cwd 与项目记忆归属"。

## 八之三、运行中插话的两种语义

`POST /api/chat {mode}`：

- `steer`（插队，默认）：进 `run.steering`，循环在**轮次边界**取走并注入 —— 不打断任何在跑的东西。
- `urgent`（立即执行）：进 `run.urgent`，并 `run.currentCall.abort()` 掐掉**当前这次模型调用**；
  循环里 `takeUrgent()` 的判定**排在重试/超时/最终回答之前** —— 已经生成的内容留档、
  丢弃可能不完整的工具调用、注入新指令、立刻开下一轮。
- 两者取走时都会落成会话里的 `steer: true` 用户消息并广播 `steer` 事件（界面据此把"等待中"换掉）。

## 八之三点五、`files` 字段的语义（交付物，不是"碰过的路径"）

`ToolResult.files` / `CallRecord.files` **只放可交付的产物** —— 即在待下载目录（`data/downloads/`）里、
能通过 `/api/downloads/file?name=` 真的下载到的文件。两类工具会填它：`deliver_file`、资源动作里带
`saveAs` 的（如 `comfyui_fetch`）。

**踩过的坑**：文件工具（`read_file` / `list_directory` / `directory_tree` / `write_file`…）早先也往
`files` 里塞"碰过的路径"，而界面把 `files` 一律渲染成**可下载的文件卡** —— 于是读一个文件、列一个目录，
消息下面就冒出一堆"下载"（用户报的 bug），点下去还只能 404（那些文件不在待下载目录里）。
现在两层防护：① 文件工具不再填 `files`（改动用 `lines` 表达）；② 界面按"是否在待下载目录里"过滤，
所以**历史记录里的旧卡片也会自动消失**（bootstrap 里下发 `downloadsDir`）。

## 八之四、界面布局与滚动（2026-10-10 第四轮）

```
┌──────────┬──────────────────────────────────┬─────────┐
│ 品牌 h-14 │ 顶栏 h-14（模型状态·项目·会话）    │         │
│──────────│──────────────────────────────────│ 待办抽屉 │
│ 会话列表  │ 消息区（自己滚）                  │（自己滚）│
│（自己滚） │──────────────────────────────────│         │
│          │ 输入框（与消息区同列 → 同宽）      │         │
└──────────┴──────────────────────────────────┴─────────┘
   20px ↕                ↕ 20px
```

- 顶栏与侧栏品牌行都是 `h-14`，下边框在同一条线上；整窗 `overflow-hidden`，
  **文档不滚**，滚动只发生在四个区域内部。之前"滚消息区时会话区跟着动"的根因是
  ChatView 根节点少了 `min-h-0` —— 整列被内容撑高，滚动落到了文档上。
- 消息区与输入框在**同一列**（所以宽度天然同步）；待办是**真实的一列**而不是浮层，
  因此它有自己的滚动条、也不会盖住消息。
- 待办抽屉**常驻右侧**（`todoOpen` 默认开，宽 16rem）：没有清单时显示说明而不是整列消失 ——
  否则消息区会随清单出现/消失忽宽忽窄。宽屏（≥sm）常驻；**手机（<sm）整列不占位**（见八之十二）。
  这里踩过一个 Tailwind v4 的坑：`hidden ... sm:flex` 里后面的 `w-64` 会把 `hidden` 顶掉
  （同层工具类按源码顺序生效），所以"手机不占位"必须写成 `max-sm:hidden`。
- 归档：`session.archivedAt` / `project.archivedAt`。归档项目的接口返回**活跃**会话列表  （界面拿它直接当侧栏数据），归档条数另给 `archivedCount` —— 早先这里返回了归档列表，
  造成"归档后侧栏变成显示已归档的会话、刷新才恢复"（第八轮修，UI 检查有回归断言）。侧栏只能归档；彻底删除只在归档页，
  且服务端要求"先归档"（未归档直接 DELETE 返回 409）。归档项目会连带归档它的会话，
  恢复同理；彻底删除项目会删掉项目记忆目录与它的会话记录，**不碰磁盘上的项目文件**。

## 八之五、版本自检（防"新前端打旧后端"）

`scripts/source-stamp.mjs` 对 `server.ts` + `src/**/*.ts|mjs` 做**内容哈希**（不用 mtime：
复制/检出会改 mtime 但内容没变，那会造成每次都提示重启的"狼来了"）。

- 构建前端时把当时的指纹 define 进 bundle（`__QIMING_STAMP__`）；
- 服务进程启动时算一次，`GET /api/version`（免登录，只报指纹/启动时间/pid）；
- 界面 boot 时比对，不一致就在顶栏下方挂一条"服务端还是旧进程"的提示；
- `test/e2e.test.mjs` 有一条断言：bundle 指纹必须等于服务端指纹（改后端忘构建时测试会红）。

会话列宽默认 `--chat-max: none`（跟随窗口），主题里 0 = 不限。

## 八之六、媒体消息与记忆归一化（2026-10-10 第六轮）

**`send_media`（内置插件「媒体消息」）**：把"给用户看"的媒体与"给模型看"的图片分开 ——
`ToolResult.images` 是给模型看的（截图，base64 走协议适配器），`ToolResult.media` 是给用户看的：

```ts
type ToolMedia = { kind: 'image'|'video'|'audio'; url?: string; download?: string; caption?: string }
```

`url` = 外部链接（前端直接加载）；`download` = 待下载目录里的文件名 ——
**为什么不给完整 URL**：`/api/downloads/file` 要登录令牌，而令牌只存在于浏览器里，
服务端拼不出可用地址，所以由前端用 `fileUrl()` 补。前端渲染成 `<img>/<video>/<audio>`，
失败退化成一行链接；附件排在正文之后、折叠组之外（收起也看得见）。

**记忆归一化**：记忆只有全局/项目两种作用域，落在 `data/memory/` 与 `data/projects/<id>/memory/`。
「记忆」页是汇总视图（`GET /api/memory?scope=all` 给各作用域计数，展开时再按作用域拉条目 ——
懒加载，N 个项目不会一进来发 N 个请求），「项目」页每个项目下的折叠块**复用同一个 `MemoryBlock`**，
两边读写同一份文件，不存在第二份副本。

## 八之七、两条通道的到达顺序（"发出去两条、刷新变一条"）

一次发送走**两条通道**：HTTP 响应（POST /api/chat 带回 runId/sessionId）与 SSE 事件（`msg`/`run_started`…）。
服务端原本是"先广播、后回响应"（`executeRun` 的首次 emit 在第一个 await 之前，是同步写出去的），
于是浏览器可能先收到事件：界面把服务端那条用户消息放进列表，随后响应到达、客户端又追加一条
"本地乐观条" —— 同一句话显示两遍，而本地条不在服务端数据里，**刷新后又只剩一条**。

两道防线：
1. **服务端**：`runs.start()` 把 `executeRun` 延到下一个 tick，先回响应再开跑；
2. **客户端**：`withOptimistic()` 追加前先查"服务端那条是不是已经在了"（内容 + 是否插话都对齐）。

`test/ui-state.test.mjs` 用桩把两种到达顺序都钉成用例（撤掉任一道防线都会红）。

## 八之八、上游故障的应对（2026-10-10 第七轮）

设计参照主流做法：Anthropic 的 429/529 退避重试与 `retry-after`、OpenAI 的"有 `Retry-After` 就用它、
否则指数退避 + 抖动"、Claude Code 的 watchdog 与 auto-resume、以及"流结束要看 `finish_reason`，
别把被掐断当成回答完了"。

**契约先行**：`StreamEvent` 的 `stop` 带 `clean`（false = 上游没给收尾标记就结束了），
`error` 带 `retryable` 与 `retryAfterMs`（由适配器解析响应头，上层别再拿文案正则猜）。

循环里的判定顺序（顺序本身就是设计）：

```
aborted → urgent（立即执行）→ cut（掐断守卫）→ streamError（含停滞；重试/自动续跑）
        → timedOut（单次调用超时）→ 无工具调用（最终回答 or 追问）→ truncated（连续截断守卫）→ 执行工具
```

- **掐断守卫**（`cut`）：`clean === false` 或压根没见到 stop → 抢救内容、注入 `loop.interrupted`、续跑；
  上限 `INTERRUPT_MAX = 2`，超了就停下并说明（不跟坏上游死磕）。
- **停滞看门狗**：单轮内一个 timer，**任何事件都重置**（含工具参数分片），所以"模型在慢慢拼长参数"
  不会被误杀；命中后把 `AbortError` 认领成"停滞、可重试"（否则适配器只会说"请求已取消"）。
- **重试**：优先用上游给的 `retryable`；退避 `max(2s·2^(n-1), Retry-After)` 加 ±20% 抖动，封顶 60s。
- **连续截断守卫**：`TRUNC_MAX = 3`（实测坏上游会一路问到轮次上限，白烧几万 token）。
- **自动续跑**：`autoContinue` 默认关；打开后重试预算用完仍按 15s 间隔接着试，上限 `autoContinueMax`。

## 八之九、附件顺序：按位置切段渲染（2026-10-10 第八轮）

问题：媒体/文件卡原先一律堆在**整段正文之后**，模型"先说一句 → 发图 → 再说一句"的顺序就丢了。
主流 harness（Claude Code 等的转录）的做法是**按顺序逐个渲染各个部分，而不是合并成一大块**。

- **数据**：`CallRecord.contentAt` = 这次调用出现的位置（本轮正文写完时的累计字符偏移）。
  循环在把本轮正文计入 `textSoFar` 之后、执行本轮调用之前算出来，传给宿主；
  轮与轮之间还会补一个 `\n\n` 分隔（`textSoFar` 同步加上，否则下一轮的偏移会差 2 个字符）。
- **正文**：消息正文 = **所有轮**的流式正文拼起来（原先只留最后一轮）——
  这样中间那几句"我先看看…"也留在转录里，位置才有意义。`run.finalText` 仍只取最后一轮
  （子智能体带回结论时不该带上碎碎念）。
- **渲染**：`ui/lib/message-parts.js` 的 `buildParts(content, calls)` 纯函数按 `contentAt` 切段，
  依次渲染 正文 → 该位置的媒体/文件卡。只有带附件的调用参与切段（读文件/跑命令只进折叠的追踪条，
  不把正文切碎）；老记录没有 `contentAt` 就夹到末尾（保持旧观感）。
- **顺带**：循环自己产生的一句收尾文案（"反复中断已停止续跑"等）改为走 `onContentDelta` ——
  正文既然由流式增量拼成，只在 `finalText` 里返回的文案就会看不见。

## 八之十、排队队列与三种「运行中发消息」（2026-10-10 第九轮，第十轮重做语义，第十一轮改默认）

交互：运行中发消息**先进队列**（不再直接插进对话）。队列在**输入框上方**、可折叠，
每条可单独「立即执行」或删除；没执行的不进消息区。

**三种语义（`SteerMode`）—— 这一版的核心是"别把三者混成一件事"**：

| mode | 何时生效 | 实现 | 界面入口 |
|---|---|---|---|
| `queue`（**默认**） | **当前这一段运行跑完之后**，自动接着执行（新开一段） | 只由 `flushQueue` 兑现 | Enter（默认） |
| `steer`（插话） | **当前轮次之内**，最近的**安全点** | 循环在轮次边界与"每次工具调用之后"取走并注入 | Alt+Enter |
| `urgent`（立即执行） | **立刻**（掐掉当前模型调用/工具） | `run.currentCall.abort()` + `takeUrgent()`，判定排在重试/超时之前 | 队列条上的「立即执行」 |

**第十一轮的关键修正（用户明确要求）**：默认从 `steer` 改成 `queue`。
旧版默认 `steer`，"运行中再发一句"会**插进当前轮次**（下个安全点就生效），与用户
"先把手上的事做完、这一段结束后再做新排的"的预期不符。现在：
- **Enter（默认）= 排队**，当前这一段跑完后自动执行；
- **只有「立即执行」会在当前轮次内反馈**（它是唯一的"插队"入口，`urgent`）；
- `steer` 仍保留为显式选项（Alt+Enter），想要当前轮次内注入时用。
- 默认值本身是**系统参数** `queueDefault`（设置 → 系统），出厂 `queue`，用户可改。

参照：dsh 的 inbox 两级 `next-turn`/`next-step`（`packages/core/agent-loop/src/inbox.ts`）
与 zcode-cli 的 Enter=同轮次 steering / Tab=下一轮次队列（其 README 的 "Active-turn input"）。

- **队列挂在会话上**（`runs.ts` 的 `queues`，不是挂在运行上）：挂在运行上会出现
  "运行结束了队列里的消息再也执行不了"的悬挂状态。`QueueItem = {id,text,ts,mode}`。
- **兑现时机**：`steer`/`urgent` 由 `takeQueued` 在运行内取走；`queue` 只在运行结束时由
  `flushQueue` 接着开下一段（**不会永远挂着**）。
- **安全点**：模型调用之后（拿完这一轮的 tool_calls）与每次工具调用之后各一次 ——
  只在轮次边界注入的话，"最后一轮没有工具调用"时插话就永远进不来（实测的缺口）。
- **接口**：`GET /api/run/queue?sessionId=`、`POST /api/run/queue {sessionId,id,action:'execute'|'remove'}`；
  `GET /api/session/<id>` 顺带返回 `queue`（刷新后排队条能恢复）。`POST /api/chat` 不传
  `mode` 时用系统参数 `queueDefault` 决定语义。
- **多观察者**：入队与"改成立即执行"都会 `broadcast` 一条 `steer` 事件（`state:'queued'`），
  取走时 `state:'taken'` —— 另一个标签页/设备也看得到队列。
- **两个实测坑**：① 客户端入队会从**两条通道**回来（POST 响应 + `queued` 广播），
  不去重就会"排队条里两条一模一样" → 统一走 `upsertQueued()` 按 id 去重；
  ② 队列用例依赖"运行确实还在跑"的窗口，3.6s 的慢流偶发错过（入队瞬间这一轮已收尾，
  队列被自动兑现）→ 测试改用 60s 的"超慢任务"模式。

## 八之十一、文件改动：检查点 + 右侧大抽屉（2026-10-10 第十轮）

- **数据**：影子 git 仓库（`src/store/checkpoints.ts`，每条会话一棵，见该文件头部注释）。
  `GET /api/changes/diff` 返回**结构化**逐行数据（`files[].lines[] = {oldNo,newNo,kind,text}`）
  与纯文本 `text` 两份 —— 界面用结构化的那份，命令行/复制用文本。
- **界面**：右列只留一条窄入口（"文件改动 · N"），点开是**占大半屏的右侧抽屉**
  （`ChangesPanel.jsx` 的 `ChangesDrawer`，挂在应用顶层）：左边检查点清单、右边 diff。
  右列 256px 放不下行号与并排视图，所以抽屉必须独立于右列。
- **diff 视图**（`DiffView.jsx` + 纯函数 `ui/lib/diff-rows.js`）：统一/并排两种；
  行号双列、增删底色、中间上下文折叠成「展开 N 行」。折叠的 `from/to` 指向**真正被藏起来的那段**
  （头尾 3 行已经单独显示）—— 曾经记的是整段上下文，于是"展开 7 行"推 10 行、头尾各重复 3 行。
- **三个实测坑**：
  ① 并排视图里落单的一侧是 `null`，`Line` 组件**先读 `line.kind` 再判空**会抛 TypeError，
  React 卸载整棵子树 → "一点「并排」抽屉就消失"。判空必须放最前；
  ② 影子仓库自带忽略清单（`out/`、`node_modules/`…），而 agent 亲写的文件恰恰可能落在里面 ——
  被忽略就等于 diff 里完全看不见。申报过的普通小文件用 `git add -f` 强记；
  ③ `git add` 是"全成功或全失败"：一条坏路径会拖垮整批，所以分批 + 失败退化成逐条重试。

## 八之十二、手机（<md）界面：两个按键、两个抽屉（2026-10-10 第十三轮）

需求原话：手机 UI 左＝会话抽屉、右＝设置抽屉，**都用按键实现**；其余日志等信息不显示，
一切以手机界面好用为准。落地如下（全部是 CSS 断点，没有 JS 端的设备分支）：

| 位置 | 手机（<md，≥ 手机竖屏） | 宽屏（≥md） |
|---|---|---|
| 顶栏 | **只有两个 40×40 的按键**：左「会话列表」、右「设置」；中间只留会话标题 | 模型状态 · 项目 · 会话名 · 上下文环 · 待办/日志/待下载/设置 |
| 会话列表 | 抽屉：`w-[86vw]` 从左侧滑出，点会话/遮罩即收；顶部让开刘海（safe-area） | 常驻左侧 16rem |
| 设置 | 抽屉：占满整屏、靠右、顶部一行固定的「设置 / 关闭」，十个板块是 44px 高的横向滚动页签 | 右侧 `max-w-4xl`，板块导航在左 |
| 右列（待办/压缩/子智能体/文件改动） | **整列不占位**（`max-sm:hidden`）：390px 再切 256px 只剩半屏 | 常驻 16rem |
| 消息区/输入框 | 左右内边距归零；发送/停止键高 40px；输入区字体 ≥16px（防 iOS 聚焦放大） | 两侧各 20px |
| 触屏细节 | `@media (pointer:coarse)`：会话行的置顶/归档**常显**（没有 hover 可悬），行内时间戳藏掉 | 悬停才出现 |

两个抽屉**互斥**：`openDrawer()` 收侧栏、`toggleSidebar()` 收设置 —— 否则两个 `fixed` 全高
抽屉的遮罩会叠在一起。状态是一处算完的（`ui/state/session.js` 的 `markDrawer()`）：
同时写到 `<html data-drawer="sessions|settings">`，既让"哪个抽屉开着"只有一个真源，
也让真机检查能直接量（不用猜 React 内部状态）。

**回归断言**：`test/ui-check.mjs` 末尾的「手机布局」段把视口切到 390×844 真跑一遍 ——
顶栏按键数 = 2 且分别是「会话列表」/「设置」、两个键 ≥40px、右列不占位、无横向滚动、
抽屉宽度与开合、`data-drawer`、互斥、以及**切回 1680 宽后会话列/右列照旧**（防手机样式带歪宽屏）。

## 九、明确不做（本期）

- 多用户、账号表、权限级别、工具白名单、审计日志（需求 2：安全保障最后再考虑）。
- 旧项目的确认（confirm）机制、单窗口互斥、本机账号绑定、deny 危险命令清单。
- 屏幕操作不再使用 OmniParser + xdotool 方案，整组删除。

## 九之二、借鉴主流 harness 的六项改造（2026-10-10 第十一轮）

对照 `deepseek-ai/deepseek-harness` 的内核（Cordis 微内核 + spill + 事件溯源会话 + turn/step + 子智能体家族），
挑可借鉴处**按性价比**逐条落地。原则统一：**参数不设服务端硬上限、全部在 UI 可见可改**；
**一切操作可执行、一切可见、一切可改、一切有记录、可追溯、可审查、易维护**。

1. **工具结果 spill**（`src/agent/spill.ts`）—— 超大工具输出落盘，只把「头尾预览 + 可 read_file
   的路径」回灌给模型（journal 仍存全文，可审计）。参数 `spillEnabled / spillMaxChars /
   spillHeadChars / spillTailChars`（设置 → 模型与参数）。落盘失败退回内联，绝不丢结果。
   界面追踪条显示「全文落盘 N 字符」。
2. **会话 append-only 事件日志**（`src/store/session-log.ts`）—— 会话历史的**唯一真源**改为一串
   只追加、不可变、带自增 seq 的事件（`append / insert / replace / compact_add / compact_remove`）；
   `session.msgs` 变为**派生物**（`deriveMessages(log)`）。旧存档读入时用 `legacyEventsFromMsgs()`
   反向补日志，重放结果与原 `msgs` 逐条一致。根治了"就地改数组写歪、上游 400 还查不出原因"
   （本工程真踩过）。日志可用 `GET /api/session/<id>/log`（`?raw=1`）审计，顶栏「日志」按钮可看。
3. **工具结果标准错误码**（`ToolErrorCode`，`src/modules/plugins/types.ts`）—— `ABORTED_BEFORE_DISPATCH`
   （未派发=没执行）/ `TOOL_OUTCOME_UNKNOWN`（已派发未应答=结果未知）/ `BUDGET_EXHAUSTED` /
   `INVALID_ARGS` / `NOT_FOUND` / `EXEC_FAILED` / `UNKNOWN_TOOL` / `LOOP_GUARD`。
   界面按码分类（追踪条显示错误码），不再靠中文文案正则猜。
4. **turn / step 分离**（`src/agent/loop.ts`）—— `round` 一个数拆成：`turn`（用户输入划的段，
   插话/打断即开新 turn）与 `step`（段内模型调用序号）。事件与落盘消息都带，统计行显示
   `turn N · step M`。
5. **子智能体可续 + 控制面**（`src/server/runs.ts` 的 `subagents` 登记表）—— 不再"带结论即消失"：
   `spawn_agent` 开子体（登记内存会话）→ `subagent_send` 带着它自己的历史**续谈** →
   `subagent_stop` 中断 → `subagent_list` 列举。`GET/POST /api/subagents` + 右列「子智能体」面板
   （可续谈、可中断）。
6. **压缩用「替换节点」**（`src/agent/context.ts`）—— 压缩状态从"掐前 N 条"改为**一串声明式节点**
   `{id, from, to, text}`：可叠加（多次压缩各记各的，互不吞）、可审计、可撤回。
   `DELETE /api/session/<id>/compact?node=` 撤回某节点（那段原历史回到请求视图）。右列
   「上下文压缩」面板可见可撤回。旧单节点存档读入时归一化。

验证：`npm run check` 91 项测试全绿（协议 / 模块 / 图像 / 端到端），`node test/ui-check.mjs` 59 项全绿。

## 九之三、设置归属归一：模型 / 系统 / 插件（2026-10-10 第十二轮）

**问题**：「模型与参数」一页把"发给上游那次请求"的东西（temperature/maxTokens）与
"智能体怎么跑"的东西（轮次上限、并发、落盘、停滞看门狗、检查点条数）混在一起 ——
概念上不是一类，界面像大杂烩，也不符合"参数归属清楚、可维护"的目标。

**现在按归属拆成三处**（`src/store/settings.ts` 的 `ModelParams` / `SystemSettings`）：

| 归属 | 内容 | 界面 | 存储 |
|---|---|---|---|
| **模型** | 服务商 + temperature / maxTokens / thinkingBudget / callTimeoutSec / retryCount / ctxLimit / echoThinking | 设置 → **模型** | `settings.params` |
| **系统** | maxRounds / maxRuns / stallSec / autoContinue(+Max) / spill*(4) / checkpointLimit / queueDefault | 设置 → **系统** | `settings.system` |
| **插件** | 每个插件自己的预算（子智能体的 `max_rounds` 就在子智能体插件里） | 设置 → **插件** | `plugins.json` 的 overrides |

- **不设服务端硬上限**（需求）：系统页每个数字都是"填多少就多少"，0 的含义写进说明
  （轮次 0 = 自动汇总插件额度；并发 0 = 不限；spill 0 = 关；检查点 0 = 全部列出）。
- **旧存档无损迁移**：`normalize()` 里 `migrateSystem()` 把旧扁平 `params` 里的系统键
  原样搬到 `system`，迁完从 `params` 删掉（`MODEL_KEYS` 白名单，脏字段不再堆）。
  单测 `设置：旧版扁平 params 里的系统参数无损迁到 system` 钉住。
- **子智能体轮次**从 `settings.params.subagentMaxRounds` 挪到**子智能体插件参数** `max_rounds`。
  旧存档里设过的值由 `migrateLegacySubagentRounds()`（启动时、建插件表之前跑一次）
  搬到 `plugins.json`，不丢。`resolveSubRounds({hint, pluginParam})` 的优先序随之简化。
- **检查点列表条数**此前是 `checkpoints.ts` 里硬编码的 `-n 200`（列不出来也不可配），
  现在读 `system.checkpointLimit`（0 = 不限）。注意：**检查点本身不会因超限被删**，
  被截的只是列表窗口。

## 十、实现现状与已知缺口（2026-10-10）

已验证：真实模型（deepseek-v4.1-flash）跑通「建文件 → 命令验证 → 汇报证据」、
`screen_doctor` + `screen_screenshot` 并**看图描述桌面**、browser-use 任务；
46 项测试（协议 30 / 模块 8 / 图像 3 / 端到端 5）全绿；类型检查 strict 通过。

已知缺口：
- **窗口控制后端**未装（`computer-use-linux setup-window-targeting` + 注销重登后才可用；
  当前能读无障碍树、能截图、能用 xdotool 输入，但按窗口聚焦/列窗口不可用）；
- 压缩（compaction）只在超阈值时做一次交接摘要，没做"多次压缩的历史合并"；
- 没有撤销（undo）与逐文件恢复（旧项目有，本期按需求未纳入）；
- 没有审计日志与访问控制（需求 2 明确推迟）。
