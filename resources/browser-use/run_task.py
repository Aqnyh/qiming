#!/usr/bin/env python3
"""run_task.py —— 把 browser-use 包成一个"命令式"外部资源。

契约（与 src/modules/resources/index.ts 的 command 形态一致）：
  从 stdin 读 JSON：{"task": "...", "max_steps": 50, "headless": false, "url": "..."}
  向 stdout 打 JSON：{"ok": true, "result": "...", "steps": 12, "urls": [...]}

模型配置三级回落（谁在前谁生效）：
  1) stdin JSON 里的 model / base_url / api_key / provider
  2) 同目录 config.json（由启明的「外部资源」页或用户手写维护）
  3) **启明自己的设置**（../../data/settings.json 里当前服务商）—— 开箱即用，不用重复配
  4) 环境变量 OPENAI_API_KEY / OPENAI_BASE_URL / BROWSER_USE_MODEL

为什么优先用系统 Chrome：本机已装 google-chrome，用它可以省掉 playwright 下载的
~150MB Chromium，而且用户自己的登录态/扩展在系统 Chrome 里（headless=false 时能看见实时过程）。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
QIMING_SETTINGS = HERE.parent.parent / "data" / "settings.json"


def read_stdin() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        print(json.dumps({"ok": False, "error": f"stdin 不是合法 JSON：{err}"}, ensure_ascii=False))
        sys.exit(0)


def load_config() -> dict:
    if CONFIG.exists():
        try:
            return json.loads(CONFIG.read_text("utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def load_qiming_provider() -> dict:
    """回落到启明当前的服务商：用户配过一次模型，浏览器任务就能直接用。"""
    try:
        settings = json.loads(QIMING_SETTINGS.read_text("utf-8"))
    except Exception:  # noqa: BLE001 —— 没配/读不到就安静回落，不是错误
        return {}
    providers = settings.get("providers") or []
    active = None
    for p in providers:
        if p.get("id") == settings.get("activeId"):
            active = p
            break
    if active is None and providers:
        active = providers[0]
    if not active or active.get("type") != "openai" or not active.get("apiKey"):
        return {}
    return {
        "base_url": active.get("baseUrl") or "",
        "api_key": active.get("apiKey") or "",
        "model": active.get("model") or "",
    }


def pick(cfg: dict, req: dict, env_key: str, cfg_key: str, default: str = "") -> str:
    return str(req.get(cfg_key) or cfg.get(cfg_key) or os.environ.get(env_key) or default)


def main() -> None:
    req = read_stdin()
    cfg = {**load_qiming_provider(), **load_config()}   # 启明设置打底，config.json 覆盖
    task = str(req.get("task") or "").strip()
    if not task:
        print(json.dumps({"ok": False, "error": "缺少 task"}, ensure_ascii=False))
        return

    try:
        from browser_use import Agent, Browser, ChatOpenAI  # type: ignore
    except Exception as err:  # noqa: BLE001 —— 缺依赖要给人话，不是堆栈
        print(json.dumps({
            "ok": False,
            "error": f"browser-use 未安装或导入失败：{err}。先运行 resources/browser-use/install.sh",
        }, ensure_ascii=False))
        return

    base_url = pick(cfg, req, "OPENAI_BASE_URL", "base_url")
    api_key = pick(cfg, req, "OPENAI_API_KEY", "api_key")
    model = pick(cfg, req, "BROWSER_USE_MODEL", "model", "gpt-4o")
    headless = bool(req.get("headless", cfg.get("headless", False)))
    max_steps = int(req.get("max_steps") or cfg.get("max_steps") or 50)

    kwargs: dict = {"model": model}
    if base_url:
        kwargs["base_url"] = base_url
    if api_key:
        kwargs["api_key"] = api_key
    # OpenCode Go 网关要求每段对话带一个稳定的 x-opencode-session，缺了直接 400
    # （MissingSessionID）。这个头由浏览器任务的 id 固定即可。
    headers: dict[str, str] = dict(cfg.get("default_headers") or {})
    # 有些网关（实测 OpenCode Go）不支持 json_schema 形式的 response_format，
    # 结构化输出要退化成"把 schema 写进系统提示词"。两个开关一起开才走得通。
    loose_schema = bool(cfg.get("loose_structured_output", req.get("loose_structured_output", True)))
    if "opencode.ai" in base_url:
        headers.setdefault("x-opencode-session", os.environ.get("OPENCODE_SESSION_ID") or f"qiming-browser-{os.getpid()}")
    if headers:
        kwargs["default_headers"] = headers
    if loose_schema:
        kwargs["dont_force_structured_output"] = True
        kwargs["add_schema_to_system_prompt"] = True
    # 4096 对"每步都要输出结构化动作"的浏览器任务偏小（实测会被截断），默认抬到 8192
    kwargs["max_completion_tokens"] = int(req.get("max_completion_tokens") or cfg.get("max_completion_tokens") or 8192)
    llm = ChatOpenAI(**kwargs)

    browser_kwargs: dict = {"headless": headless}
    browser_kwargs["enable_default_extensions"] = bool(req.get("extensions", cfg.get("extensions", True)))

    # 代理：browser-use 启动时要下 uBlock 这类扩展（Chrome 商店在墙外），
    # 所以**两条路都要走代理** —— Python 侧的下载用环境变量，Chrome 自身的流量用 --proxy-server。
    # 回环与内网段绕过代理（否则访问本机 ComfyUI/文档站会被代理拦下）。
    proxy = str(req.get("proxy") or cfg.get("proxy") or "").strip()
    if proxy:
        for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
            os.environ.setdefault(k, proxy)
    args: list[str] = list(cfg.get("chrome_args") or [])
    if proxy:
        args.append(f"--proxy-server={proxy}")
        args.append("--proxy-bypass-list=localhost;127.0.0.1;192.168.0.0/16;10.0.0.0/8")
    if args:
        browser_kwargs["args"] = args
    chrome = "/usr/bin/google-chrome"
    if Path(chrome).exists():
        browser_kwargs["executable_path"] = chrome
    elif cfg.get("chrome_path"):
        browser_kwargs["executable_path"] = cfg["chrome_path"]
    if req.get("user_data_dir") or cfg.get("user_data_dir"):
        browser_kwargs["user_data_dir"] = str(req.get("user_data_dir") or cfg["user_data_dir"])

    import asyncio

    async def run() -> dict:
        browser = Browser(**browser_kwargs)
        agent = Agent(task=task, llm=llm, browser=browser, use_vision=True)
        history = await agent.run(max_steps=max_steps)
        try:
            result = history.final_result() or ""
        except Exception:  # noqa: BLE001
            result = ""
        urls: list[str] = []
        try:
            urls = [u for u in (history.urls() or [])][-10:]
        except Exception:  # noqa: BLE001
            urls = []
        return {
            "ok": bool(result) and history.is_successful() is not False,
            "result": result or "（browser-use 没有给出最终结果，可能没跑完）",
            "steps": len(getattr(history, "history", []) or []),
            "urls": urls,
        }

    budget = float(req.get("timeout") or cfg.get("timeout") or 0)

    async def guarded() -> dict:
        if budget > 0:
            return await asyncio.wait_for(run(), timeout=budget)
        return await run()

    try:
        out = asyncio.run(guarded())
    except asyncio.TimeoutError:
        out = {"ok": False, "error": f"浏览器任务超过 {budget:.0f} 秒没有完成（可在 config.json 里调 timeout，或把任务写小一点）"}
    except Exception as err:  # noqa: BLE001
        out = {"ok": False, "error": f"运行失败：{type(err).__name__}: {err}"}

    # 给模型看的文本：结果在前，元信息在后
    if out.get("ok"):
        text = out["result"]
    else:
        text = f"未完成：{out.get('error') or out.get('result')}"
    print(json.dumps({**out, "text": text}, ensure_ascii=False))


if __name__ == "__main__":
    main()
