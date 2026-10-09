#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS 安装包只能在 macOS 上构建。" >&2
  exit 1
fi

cd "$ROOT_DIR"

if [[ "$#" -gt 1 ]] || [[ "$#" -eq 1 && "$1" != "--arch=arm64" && "$1" != "--all" ]]; then
  echo "macOS App 只支持 Apple Silicon arm64；可省略参数，或使用 --arch=arm64 / --all。" >&2
  exit 1
fi

node scripts/ensure-package-dependencies.mjs
exec node scripts/package-macos.mjs --arch=arm64
