# 浏览器操作：browser-use

这个目录把 [browser-use](https://github.com/browser-use/browser-use)（开源浏览器智能体）包成启明的一个
**外部资源（command 形态）**：模型调用 `browser_task` 工具 → 这里用 Python 跑 browser-use → 结果回给模型。

## 装一次

```bash
bash resources/browser-use/install.sh
```

它会建一个独立 venv（`./.venv`）并装 `browser-use`。若系统里已装 Chrome/Chromium，
会优先用它，**不依赖** playwright 另外下载的 Chromium（下载失败也不影响用系统浏览器）。

## 接哪个模型

browser-use 自己也是一个 agent，需要一个"会用工具"的模型。四级取配置，先命中先用：

1. 工具调用参数（一般不用手填）
2. 本目录的 `config.json`
3. **启明自己的服务商设置**（`data/settings.json` 里当前那条）—— 所以界面里配过模型，这里就能直接跑
4. 环境变量 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `BROWSER_USE_MODEL`

`config.json` 的全部字段（都有默认值，可以不写）。
仓库里给的是 `config.example.json`，复制一份改名即用（`config.json` 被 `.gitignore` 忽略，
是"每台机器自己的"配置）：

```bash
cp resources/browser-use/config.example.json resources/browser-use/config.json
```

```json
{
  "headless": true,                 // 无头；调试时设 false 能看着它操作
  "max_steps": 50,
  "timeout": 600,                   // 整个任务的墙钟上限（秒）
  "extensions": true,               // 预置扩展（uBlock 等）—— 需要能访问 Chrome 商店
  "max_completion_tokens": 8192,    // 每步 4096 偏小（实测会被截断）
  "loose_structured_output": true,  // 网关不支持 json_schema 时把 schema 写进系统提示词
  "chrome_args": [],                // 追加的 Chrome 参数
  "default_headers": {},            // 追加的请求头
  "proxy": ""                       // 需要科学上网时填，如 "http://127.0.0.1:7890"；不需要就留空
}
```

> `proxy` 会把环境变量（Python 侧下载）与 `--proxy-server`（Chrome 自身流量）一起设上。
> 只有在你确实需要走代理访问外网时才填；留空则直连。

### 三个实测踩过的坑（都已在代码里处理）

1. **扩展下载要代理**：browser-use 启动时会去 Chrome 商店下 uBlock，被墙时**卡死在启动阶段**
   （一直停在 "Downloading uBlock Origin Lite extension..."）。`config.json` 里的 `proxy`
   同时给了 Python 侧（环境变量）和 Chrome（`--proxy-server`，并绕回环与内网段）。
2. **OpenCode Go 要 `x-opencode-session` 头**：缺了直接 400（MissingSessionID）。
   runner 会在 base_url 命中 `opencode.ai` 时自动带上（值可用 `OPENCODE_SESSION_ID` 固定）。
3. **网关不支持 `response_format: json_schema`**：`loose_structured_output: true` 会把 schema
   塞进系统提示词，绕开这个限制（实测 OpenCode Go + deepseek 走这条路才跑通）。

> 注意：`config.json` 里是明文密钥。本工程按需求不做访问控制（数据目录在 NTFS 上也没有权限位），
> 请只在本机使用。

## 自测

```bash
cd resources/browser-use
echo '{"task":"打开 example.com 并告诉我页面标题"}' | ./.venv/bin/python run_task.py
```

成功时 stdout 是一行 JSON：`{"ok": true, "result": "...", "steps": 7, "urls": [...]}`。

## 与「屏幕操作」的分工

- **浏览器操作（这里）**：网页任务、抓取、填表、登录后操作 —— 用它。
- **屏幕操作（computer-use-linux）**：本机桌面应用、非浏览器界面 —— 用那个。
  两者都能"看屏幕"，但 browser-use 直接操作 DOM/无障碍树、更稳更省，网页任务不要用屏幕操作。

## 无头还是看得见

`headless: false`（默认）会弹出真实浏览器窗口，用户能看着它干活 —— 调试期推荐。
批量/无人值守时在 `config.json` 里设 `"headless": true`。
