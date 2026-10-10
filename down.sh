#!/usr/bin/env bash
# 停止启明 agent（并顺手收掉它拉起的 MCP 子进程）。
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$ROOT/data/server.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "没有 pid 文件，可能本来就没在跑"
  exit 0
fi
PID="$(cat "$PIDFILE" 2>/dev/null || echo '')"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "进程 $PID 不在运行"
  rm -f "$PIDFILE"
  exit 0
fi

kill "$PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.3
done
if kill -0 "$PID" 2>/dev/null; then
  echo "进程没退出，强杀"
  kill -9 "$PID" 2>/dev/null || true
fi
rm -f "$PIDFILE"
echo "已停止（pid $PID）"
