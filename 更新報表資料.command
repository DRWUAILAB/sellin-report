#!/bin/zsh
# Sell-in 報表（Mac）：抓 NetSuite 最新資料、重建加密資料並發布到 GitHub（邏輯在 build/publish.py）
cd "$(dirname "$0")"
PY="$HOME/.local/sellin-venv/bin/python"
[ -x "$PY" ] || PY=python3
"$PY" build/publish.py "$@" || echo "\nFAILED - see the messages above."
read -k1 "?按任意鍵關閉…"
