#!/usr/bin/env bash
# 安装 browser-use 运行环境（本机专用）。
#
#   bash resources/browser-use/install.sh
#
# 为什么用独立 venv：browser-use 依赖 playwright 与一堆 Python 包，
# 装进系统 Python 会污染全局；这个目录下的 .venv 是它自己的世界，删掉即净。
set -euo pipefail

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

MIRROR="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"

if ! command -v uv >/dev/null 2>&1; then
  echo "需要 uv（https://docs.astral.sh/uv/）：未找到" >&2
  exit 1
fi

echo "== 建 venv（Python 3.12） =="
uv venv .venv --python 3.12

echo "== 装 browser-use（镜像：$MIRROR） =="
uv pip install --python .venv/bin/python -i "$MIRROR" browser-use

echo "== 装 Chromium（playwright；本机已有 google-chrome 时会优先用它） =="
.venv/bin/python -m playwright install chromium || {
  echo "（playwright 浏览器安装失败，不影响使用系统 Chrome）" >&2
}

echo
echo "完成。自测："
echo "  echo '{\"task\":\"打开 example.com 并告诉我页面标题\"}' | ./.venv/bin/python run_task.py"
