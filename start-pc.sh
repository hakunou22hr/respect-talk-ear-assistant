#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 24 LTSを https://nodejs.org/ からインストールしてください。'
  exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo '.envへGemini APIキーを登録し、保存してからもう一度起動してください。'
  exit 0
fi
exec node --env-file-if-exists=.env server/local.js
