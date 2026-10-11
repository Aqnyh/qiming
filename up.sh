#!/usr/bin/env bash
# 启动启明 agent。
#
#   bash up.sh                # 默认 0.0.0.0:8787（手机/其它设备也能连）
#   PORT=9000 bash up.sh
#   HOST=127.0.0.1 bash up.sh # 只允许本机访问
#   QIMING_AUTH=off bash up.sh # 关掉登录（自动化/完全信任场景）
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
PIDFILE="$ROOT/data/server.pid"
LOGFILE="$ROOT/data/server.log"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node（需要 Node >= 22.6，工程用它的原生 TS 支持直接跑 .ts）" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 版本过低（当前 $(node -v)），需要 >= 22.6" >&2
  exit 1
fi

mkdir -p "$ROOT/data"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null || echo 0)" 2>/dev/null; then
  echo "启明已在运行（pid $(cat "$PIDFILE")）"
  exit 0
fi

# 首次运行：先装依赖（node_modules 不入库），再构建前端
# 顺序不能反 —— 构建前端要用到 esbuild/tailwind，它们都在 devDependencies 里。
if [ ! -d "$ROOT/node_modules" ]; then
  echo "== 首次运行：安装依赖 =="
  if [ -f "$ROOT/package-lock.json" ]; then
    npm ci || npm install
  else
    npm install
  fi
fi
if [ ! -f "$ROOT/public/app.js" ]; then
  echo "== 首次运行：构建前端 =="
  npm run build:ui
fi

: > "$LOGFILE"
setsid nohup env PORT="$PORT" HOST="$HOST" node server.ts >> "$LOGFILE" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

for _ in $(seq 1 40); do
  if grep -q "启明已启动" "$LOGFILE" 2>/dev/null; then break; fi
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "启动失败：" >&2
    tail -30 "$LOGFILE" >&2
    exit 1
  fi
  sleep 0.5
done

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
echo "启明已启动（pid $(cat "$PIDFILE")）"
echo "  本机：http://127.0.0.1:$PORT/"
[ "$HOST" = "0.0.0.0" ] && [ -n "${LAN_IP:-}" ] && echo "  局域网：http://$LAN_IP:$PORT/"
echo "  登录：用本机账号 $(whoami) 的密码（登录后才能用 sudo 提权）"
echo "  日志：tail -f $LOGFILE"
