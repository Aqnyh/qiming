# 模块文件：位置、字段、例子

启明把「插件 / 外部资源 / 提示词 / 技能 / 记忆」都放在 `data/` 下的文件里。
**直接改文件就能增改，改完立刻生效**（服务每 2 秒检查一次，检测到变化就热加载，不用重启）。

改之前先读一遍原文件，只改你要改的那块；JSON 要合法（写完用 `read_file` 读回来确认能解析）。
改完用 `list_plugins`、`list_skills`、`resource_list`（或再读一次文件）核对。

---

## 1. `data/plugins.json` —— 插件

```json
{
  "overrides": {
    "<插件id>": { "enabled": true, "params": { "timeout_sec": 1200 } }
  },
  "custom": [
    {
      "id": "my-plugin",
      "name": "我的插件",
      "desc": "一句话说明（注入系统提示词）",
      "prompt": "用法说明：什么时候用它、注意什么",
      "enabled": true,
      "params": [
        { "key": "suffix", "name": "后缀", "type": "string", "def": "！" }
      ],
      "tools": [
        {
          "name": "my_tool",
          "desc": "给模型看的工具描述",
          "schema": {
            "type": "object",
            "properties": { "name": { "type": "string", "description": "名字" } },
            "required": ["name"]
          },
          "command": "printf '你好 %s\\n' {name}",
          "stdin": "none"
        }
      ]
    }
  ]
}
```

要点：

- `overrides` 只管**启停**与**参数**；用法提示词在 `prompts.json` 里（条目 id `plugin.<插件id>.usage`）。
- 自定义插件的工具就是**一条命令模板**：`{参数名}` 会被 shell 安全转义后替换；
  `"stdin": "json"` 时参数以 JSON 从标准输入喂进去（适合参数多的命令）。
- 工具名全局唯一，建议带前缀（`my_tool`）。
- 内置插件 id：`fs` `exec` `wait` `deliver` `todo` `search` `memory` `skills` `subagent`。

## 2. `data/resources.json` —— 外部资源

```json
{
  "resources": [
    {
      "id": "my-api",
      "name": "我的服务",
      "kind": "http",
      "desc": "注入系统提示词的说明：这个资源能干什么、什么时候用",
      "enabled": true,
      "baseUrl": "http://127.0.0.1:9000",
      "actions": [
        {
          "name": "my_status",
          "desc": "看服务状态",
          "method": "GET",
          "path": "/status",
          "params": [{ "key": "q", "in": "query", "type": "string", "desc": "可选过滤词" }]
        },
        {
          "name": "my_submit",
          "desc": "提交一个任务",
          "method": "POST",
          "path": "/jobs",
          "params": [{ "key": "job", "in": "body", "type": "object", "required": true }],
          "saveAs": "filename"
        }
      ],
      "params": { "timeout_sec": 600 }
    },
    {
      "id": "my-mcp",
      "name": "某个 MCP 服务器",
      "kind": "mcp",
      "desc": "stdio MCP 服务器，工具由它自报",
      "enabled": true,
      "command": "npx -y some-mcp-server",
      "env": { "TOKEN": "xxx" }
    },
    {
      "id": "my-cli",
      "name": "某个命令行工具",
      "kind": "command",
      "desc": "把本地命令包成工具",
      "enabled": true,
      "tools": [
        {
          "name": "my_cli_run",
          "desc": "跑一次",
          "schema": { "type": "object", "properties": { "task": { "type": "string" } }, "required": ["task"] },
          "command": "cd /path/to/tool && ./run.sh",
          "stdin": "json",
          "timeoutSec": 900
        }
      ]
    }
  ]
}
```

要点：

- 三种形态：`mcp`（stdio，工具自报）、`http`（声明式动作）、`command`（命令模板）。
- 工具名会自动加资源前缀：`<资源id>_<动作名>`（动作名已经带前缀就不重复加）。
- 资源说明与每个工具的描述都是**提示词**，也能在「设置 → 提示词」里改：
  条目 id 是 `res.<资源id>.usage` 与 `tool.<工具名>.desc` —— 两处改的是同一条。
- `params`（如 `timeout_sec`）是调用参数，存在资源自己这里。
- 加了 `mcp` 资源后服务会自动尝试连接；连不上时到界面「外部资源 → 测试连接」看报错。

## 3. `data/prompts.json` —— 全部提示词

```json
{
  "overrides": {
    "system.base": { "text": "改写后的系统提示词" },
    "plugin.fs.usage": { "text": "改写后的文件插件用法" },
    "loop.no_content": { "enabled": false }
  }
}
```

- 条目 id 用 `GET /api/prompts` 查（或读 `data/prompts.json` 里已有的 id 照抄）。
- 默认文本在代码里（`src/modules/prompts/defaults.ts` 与各模块），这里只存**覆盖**；
  删掉某条覆盖 = 恢复默认。
- **单一真源**：插件页、资源页、记忆页、技能页改的提示词，和这里改的是同一条记录，
  两边看到的内容与效果完全一致。

## 4. `data/skills/<名字>/SKILL.md` —— 技能

```markdown
---
name: my-skill
description: 做什么 + 什么时候用（模型靠它决定要不要载入）
---

正文：步骤、命令、坑、验证方式（≤500 行，长细节放同目录的参考文件）
```

技能目录里还可以放 `scripts/`、`references/`、`assets/`，用 `read_file` 按需读。

## 5. 记忆

- 全局：`data/memory/<slug>.md`；项目：`data/projects/<项目id>/memory/<slug>.md`
- 格式：frontmatter（`name` / `description` / `metadata.type`）+ 正文；
  同目录的 `MEMORY.md` 是索引（`- [标题](memory/文件.md) — 摘要`）。
- 也可以直接用 `memory_write` / `memory_forget` 工具（等价，工具会顺手重建索引）。

---

## 自检清单

1. 改完 JSON 后 `read_file` 读回来，确认能解析（服务热加载失败会保留旧配置，不会清空你的文件）。
2. `list_plugins` / `list_skills` 看是否已生效；`resource_list` 看资源与工具。
3. 新工具要下一轮模型调用才会出现在工具表里 —— 本轮先用 `run_command` 或文件工具验证。
4. 改坏了就把 `read_file` 读到的原文改回去（服务有 `.bak` 留档：`<文件>.bak`）。
