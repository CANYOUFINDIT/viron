#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v node >/dev/null 2>&1; then
  VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
else
  VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -n 1)"
fi
OUTPUT_DIR="$ROOT_DIR/dist/monitor"

if [[ -z "$VERSION" ]]; then
  echo "无法从 package.json 读取 Viron 版本。" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_COMMAND=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256_COMMAND=(shasum -a 256)
else
  echo "构建 viron-monitor 需要 sha256sum 或 shasum。" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

build_arch() {
  local arch="$1"
  local target="$OUTPUT_DIR/linux-$arch"
  mkdir -p "$target"
  (
    cd "$ROOT_DIR/monitor"
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -mod=mod -trimpath -ldflags="-s -w -X main.version=$VERSION" -o "$target/viron-monitor" .
  )
  (
    cd "$ROOT_DIR/monitor/collector"
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -mod=mod -tags=custom -trimpath -ldflags="-s -w" -o "$target/viron-monitor-collector" .
  )
  install -m 0644 "$ROOT_DIR/monitor/viron-monitor.service" "$target/viron-monitor.service"
  install -m 0644 "$ROOT_DIR/monitor/viron-monitor.service.legacy" "$target/viron-monitor.service.legacy"
  install -m 0644 "$ROOT_DIR/monitor/THIRD_PARTY_NOTICES.md" "$target/THIRD_PARTY_NOTICES.md"
  install -m 0755 "$ROOT_DIR/monitor/install.sh" "$target/install.sh"
  printf '{"product":"viron-monitor","version":"%s","architecture":"%s"}\n' "$VERSION" "$arch" > "$target/manifest.json"
  (
    cd "$target"
    "${SHA256_COMMAND[@]}" viron-monitor viron-monitor-collector viron-monitor.service viron-monitor.service.legacy THIRD_PARTY_NOTICES.md install.sh manifest.json > SHA256SUMS
  )
  test -s "$target/viron-monitor"
  test -s "$target/viron-monitor-collector"
  test -s "$target/manifest.json"
  test -s "$target/SHA256SUMS"
  go version -m "$target/viron-monitor" | grep -Fq $'\tpath\tgithub.com/CANYOUFINDIT/viron/monitor'
  go version -m "$target/viron-monitor-collector" | grep -Fq $'\tpath\tgithub.com/CANYOUFINDIT/viron/monitor/collector'
  ls -lh "$target/viron-monitor" "$target/viron-monitor-collector"
}

build_arch amd64
build_arch arm64
