#!/usr/bin/env python3
"""
resources/proxy/proxy.py —— 走本机 mihomo 代理访问被墙资源（GitHub 等）。

为什么要它：本机访问 GitHub / raw.githubusercontent / google 等必须走代理；
mihomo 装在 /usr/local/bin/mihomo，配置在 ~/.config/mihomo（混合端口 7890、控制台 9090）。

这一个脚本承担三种动作（stdin 传 JSON，含 "action" 字段）：
  · start  —— 确保 mihomo 在跑（先看 7890 通不通；不通就起 systemd user service，
              再退化为直接 nohup 起 mihomo）。返回端口与出口 IP。
  · probe  —— 用代理探测若干 URL 的 HTTP 状态与耗时（默认探 GitHub 三件套）。
  · fetch  —— 用代理取一个 URL 的内容并落盘（默认 tools/proxy-out/<host>/<name>），
              返回落盘路径。（用户说"下载下来改动之后复用"时用它取源码。）

设计取舍：
  · 只用标准库（urllib），不额外装依赖。
  · 端口可配（--port / JSON 里的 proxy）。
  · 一切可见：每个动作都在 stdout 打印人话结果，命令吃掉 exit code 判断成败。
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path.home()
CONFIG_DIR = HOME / ".config" / "mihomo"
BIN = "/usr/local/bin/mihomo"
DEFAULT_PROXY = "http://127.0.0.1:7890"
CONTROLLER = "http://127.0.0.1:9090"
DEFAULT_PROBE = [
    "https://api.github.com",
    "https://raw.githubusercontent.com/MetaCubeX/mihomo/Meta/README.md",
    "https://www.google.com/generate_204",
]


def log(*a):
    print(*a, flush=True)


def read_stdin_json() -> dict:
    """从 stdin 读 JSON（command 资源以 stdin:json 调用）。读不到就返回空 dict。"""
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        return json.loads(raw)
    except Exception:
        return {}


def proxy_reachable(proxy: str, timeout: float = 4.0) -> bool:
    """代理端口是否可用：拿 google 204 做探针。"""
    try:
        op = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        )
        req = urllib.request.Request(
            "https://www.google.com/generate_204",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with op.open(req, timeout=timeout) as r:
            return r.status in (200, 204)
    except Exception:
        return False


def port_open(host: str, port: int) -> bool:
    import socket

    with socket.socket() as s:
        s.settimeout(1.0)
        return s.connect_ex((host, port)) == 0


def start_proxy(proxy: str) -> int:
    """确保 mihomo 在跑。返回 0 表示最终可用。"""
    host, port = _split_proxy(proxy)
    if port_open(host, port) and proxy_reachable(proxy):
        log(f"[proxy] 已在运行：{proxy}")
        return 0
    if port_open(host, port):
        log(f"[proxy] 端口 {port} 已在监听，但代理探针未通过——可能节点未就绪，稍等/换节点。")

    # 1) 先试 systemd user service（最干净）
    uid = os.getuid()
    env = {**os.environ, "XDG_RUNTIME_DIR": f"/run/user/{uid}"}
    r = subprocess.run(
        ["systemctl", "--user", "start", "mihomo"],
        env=env, capture_output=True, text=True,
    )
    if r.returncode == 0:
        log("[proxy] 已通过 systemd user service 启动 mihomo")
    else:
        log(f"[proxy] systemd 启动失败（{r.stderr.strip() or 'rc=' + str(r.returncode)}），改为直接拉起")
        subprocess.Popen(
            [BIN, "-d", str(CONFIG_DIR)],
            stdout=open("/tmp/mihomo.log", "ab"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env={**os.environ, "HOME": str(HOME)},
        )
        log("[proxy] 已直接拉起 mihomo（日志 /tmp/mihomo.log）")

    # 2) 等它就绪（最多 15 秒）
    for i in range(15):
        time.sleep(1)
        if port_open(host, port) and proxy_reachable(proxy):
            log(f"[proxy] 就绪：{proxy}（用时 {i + 1}s）")
            return 0
    log(f"[proxy] 启动后仍不可用，请检查配置：mihomo -t -d {CONFIG_DIR}")
    return 1


def _split_proxy(proxy: str):
    from urllib.parse import urlparse

    u = urlparse(proxy)
    return (u.hostname or "127.0.0.1", u.port or 7890)


def make_opener(proxy: str):
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    else:
        handlers.append(urllib.request.ProxyHandler({}))  # 显式直连
    return urllib.request.build_opener(*handlers)


def probe(urls, proxy: str) -> int:
    op = make_opener(proxy)
    bad = 0
    for u in urls:
        t0 = time.time()
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
            with op.open(req, timeout=25) as r:
                log(f"  {r.status}  {time.time() - t0:5.2f}s  {u}")
        except urllib.error.HTTPError as e:
            log(f"  {e.code}  {time.time() - t0:5.2f}s  {u}")
        except Exception as e:
            bad += 1
            log(f"  ERR  {time.time() - t0:5.2f}s  {u}  {e}")
    return 1 if bad else 0


def fetch(url: str, out: str | None, proxy: str) -> int:
    op = make_opener(proxy)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with op.open(req, timeout=60) as r:
            data = r.read()
            status = r.status
    except Exception as e:
        log(f"[fetch] 失败：{e}")
        return 1
    if not out:
        from urllib.parse import urlparse

        u = urlparse(url)
        name = os.path.basename(u.path) or "index.html"
        out = str(Path("tools") / "proxy-out" / (u.hostname or "out") / name)
    p = Path(out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    log(f"[fetch] {status}  {len(data)} 字节  →  {p.resolve()}")
    return 0


def fetch_tarball(owner_repo: str, ref: str, out_dir: str | None, proxy: str) -> int:
    """下载 GitHub 仓库的 tar.gz 并解压（用代理）。owner_repo 形如 'deepseek-ai/deepseek-harness'。"""
    import io
    import tarfile

    ref = ref or ""
    if not ref:
        # 自动探测默认分支（main / master 猜错会 404，探一次 API 最稳）
        try:
            api = urllib.request.Request(
                f"https://api.github.com/repos/{owner_repo}",
                headers={"User-Agent": "Mozilla/5.0"},
            )
            with make_opener(proxy).open(api, timeout=30) as r:
                ref = json.loads(r.read().decode("utf-8")).get("default_branch") or "main"
        except Exception:
            ref = "main"
        log(f"[tarball] 默认分支：{ref}")
    url = f"https://codeload.github.com/{owner_repo}/tar.gz/refs/heads/{ref}"
    op = make_opener(proxy)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with op.open(req, timeout=180) as r:
            data = r.read()
            status = r.status
    except Exception as e:
        log(f"[tarball] 下载失败：{e}")
        return 1
    if out_dir is None:
        out_dir = str(Path("tools") / "proxy-out" / (owner_repo.replace("/", "__") + "-" + ref))
    p = Path(out_dir)
    p.mkdir(parents=True, exist_ok=True)
    log(f"[tarball] {status}  {len(data)} 字节  →  解压到 {p.resolve()}")
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            tf.extractall(p)
    except Exception as e:
        log(f"[tarball] 解压失败：{e}")
        return 1
    log(f"[tarball] 完成（顶层目录 {owner_repo.split('/')[-1]}）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="走 mihomo 代理访问被墙资源")
    ap.add_argument("--action", default=None, help="start / probe / fetch（不给则从 stdin JSON 读）")
    ap.add_argument("--proxy", default=None, help=f"代理地址，默认 {DEFAULT_PROXY}")
    ap.add_argument("--url", default=None, help="fetch 的目标 URL")
    ap.add_argument("--out", default=None, help="fetch 的落盘路径（或 tarball 的解压目录）")
    args, _ = ap.parse_known_args()

    payload = read_stdin_json()
    action = args.action or payload.get("action") or "start"
    proxy = args.proxy or payload.get("proxy") or DEFAULT_PROXY
    url = args.url or payload.get("url")
    out = args.out or payload.get("out")

    if action == "start":
        rc = start_proxy(proxy)
        if rc == 0:
            log(f"[proxy] 用法示例：curl -x {proxy} https://api.github.com")
        return rc
    if action == "probe":
        start_proxy(proxy)
        urls = payload.get("urls") or DEFAULT_PROBE
        log(f"[probe] 经 {proxy} 探测 {len(urls)} 个地址：")
        return probe(urls, proxy)
    if action == "fetch":
        if not url:
            log("[fetch] 缺少 url")
            return 2
        start_proxy(proxy)
        return fetch(url, out, proxy)
    if action == "tarball":
        repo = payload.get("repo")
        if not repo:
            log("[tarball] 缺少 repo（形如 deepseek-ai/deepseek-harness）")
            return 2
        start_proxy(proxy)
        return fetch_tarball(repo, payload.get("ref") or "", out, proxy)
    log(f"未知 action：{action}（应为 start / probe / fetch / tarball）")
    return 2


if __name__ == "__main__":
    sys.exit(main())
