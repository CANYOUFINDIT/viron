#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS 安装包只能在 macOS 上构建。" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "正在按 package-lock.json 同步依赖..."
npm ci --cache "$ROOT_DIR/.npm-cache" --prefer-offline --no-audit --no-fund

if [[ "${1:-}" == "--all" ]]; then
  if [[ "$#" -ne 1 ]]; then
    echo "--all 不能与其他参数一起使用。" >&2
    exit 1
  fi
  node scripts/package-macos.mjs --arch=arm64
  node scripts/package-macos.mjs --arch=x64
else
  exec node scripts/package-macos.mjs "$@"
fi
