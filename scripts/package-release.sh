#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$ROOT_DIR/release"

usage() {
  cat <<'USAGE'
Usage: ./scripts/package-release.sh [--refresh-docker-cache] [version]

Build all supported Viron release artifacts:
  - macOS arm64 and x64 DMGs
  - Windows x86, x64, and arm64 NSIS installers
  - linux/amd64 and linux/arm64 offline bundles, each containing
    viron-server-lite, viron-server-full, and viron-script-runner

When version is omitted, package.json version is used. Passing a different
version permanently updates the repository version, Compose image tags, and
versioned documentation before building.

Docker layers use a project-local BuildKit cache under .tmp by default.
Use --refresh-docker-cache to ignore cached layers once and refresh that cache.

Examples:
  ./scripts/package-release.sh
  ./scripts/package-release.sh 0.1.6
  ./scripts/package-release.sh --refresh-docker-cache 0.1.6
USAGE
}

REFRESH_DOCKER_CACHE=false
VERSION_ARGUMENT=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --refresh-docker-cache)
      REFRESH_DOCKER_CACHE=true
      ;;
    --*)
      echo "未知参数：$1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$VERSION_ARGUMENT" ]]; then
        echo "只能指定一个发布版本。" >&2
        usage >&2
        exit 1
      fi
      VERSION_ARGUMENT="$1"
      ;;
  esac
  shift
done
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "全平台客户端发布必须在 macOS 上执行。" >&2
  exit 1
fi

for command_name in node npm docker gzip tar shasum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少发布依赖：$command_name" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "Docker 未运行，无法构建服务镜像。" >&2
  exit 1
fi
if ! buildx_details="$(docker buildx inspect --bootstrap 2>/dev/null)"; then
  echo "Docker Buildx 不可用，无法构建多架构服务镜像。" >&2
  exit 1
fi
for required_platform in linux/amd64 linux/arm64; do
  if [[ "$buildx_details" != *"$required_platform"* ]]; then
    echo "当前 Docker Buildx 不支持 $required_platform。" >&2
    exit 1
  fi
done

cd "$ROOT_DIR"

if [[ -n "$VERSION_ARGUMENT" ]]; then
  VERSION="$VERSION_ARGUMENT"
else
  VERSION="$(node -p 'require("./package.json").version')"
fi
node scripts/sync-release-version.mjs "$VERSION"
VERSION="$(node -p 'require("./package.json").version')"

DOCKER_CACHE_ROOT="${VIRON_DOCKER_CACHE_DIR:-$ROOT_DIR/.tmp/docker-build-cache}"
if [[ "$DOCKER_CACHE_ROOT" != /* ]]; then
  DOCKER_CACHE_ROOT="$ROOT_DIR/$DOCKER_CACHE_ROOT"
fi
APT_MIRROR="${VIRON_APT_MIRROR:-http://mirrors.aliyun.com/debian}"
APT_SECURITY_MIRROR="${VIRON_APT_SECURITY_MIRROR:-http://mirrors.aliyun.com/debian-security}"
DOCKER_REGISTRY_MIRROR="${VIRON_DOCKER_REGISTRY_MIRROR:-docker.io}"

cleanup_temporary_files() {
  rm -f "$RELEASE_DIR"/*.tmp
}
trap cleanup_temporary_files EXIT

echo "正在按 package-lock.json 同步依赖..."
npm ci --cache "$ROOT_DIR/.npm-cache" --prefer-offline --no-audit --no-fund
node -e '
  const { accessSync, constants } = require("node:fs");
  const electronPath = require("electron");
  accessSync(electronPath, constants.X_OK);
  process.stdout.write(`Electron: ${electronPath}\n`);
'

echo "正在验证源码..."
npm run typecheck
npm test
npm run build

mkdir -p "$RELEASE_DIR"

echo "正在构建 macOS arm64 与 x64 安装包..."
node scripts/package-macos.mjs --arch=arm64
node scripts/package-macos.mjs --arch=x64

echo "正在构建 Windows x86、x64 与 arm64 安装包..."
node scripts/package-windows.mjs --arch=ia32
node scripts/package-windows.mjs --arch=x64
node scripts/package-windows.mjs --arch=arm64

verify_bundle_tags() {
  local bundle_path="$1"
  gzip -dc "$bundle_path" \
    | tar -xOf - manifest.json \
    | EXPECTED_RELEASE_VERSION="$VERSION" node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const version = process.env.EXPECTED_RELEASE_VERSION;
        const expected = new Set([
          `viron-server-lite:${version}`,
          `viron-server-full:${version}`,
          `viron-script-runner:${version}`,
        ]);
        const manifests = JSON.parse(input);
        const actual = new Set(manifests.flatMap((entry) => entry.RepoTags ?? []));
        if (actual.size !== expected.size || [...expected].some((tag) => !actual.has(tag))) {
          throw new Error(`离线包镜像标签不完整：${[...actual].join(", ")}`);
        }
      });
    '
}

build_server_image() {
  local architecture="$1"
  local target="$2"
  local image="$3"
  local platform="linux/$architecture"
  local cache_directory="$DOCKER_CACHE_ROOT/release/$architecture/$target"
  local build_args=(
    docker buildx build
    --platform "$platform"
    --target "$target"
    --tag "$image"
    --load
    --build-arg "APT_MIRROR=$APT_MIRROR"
    --build-arg "APT_SECURITY_MIRROR=$APT_SECURITY_MIRROR"
    --build-context "golang:1.26-bookworm=docker-image://$DOCKER_REGISTRY_MIRROR/library/golang:1.26-bookworm"
    --build-context "node:22-bookworm-slim=docker-image://$DOCKER_REGISTRY_MIRROR/library/node:22-bookworm-slim"
  )

  if [[ "$REFRESH_DOCKER_CACHE" == true ]]; then
    build_args+=(--no-cache)
  elif [[ -s "$cache_directory/index.json" ]]; then
    build_args+=(--cache-from "type=local,src=$cache_directory")
  fi
  build_args+=(--cache-to "type=local,dest=$cache_directory,mode=max" "$ROOT_DIR")

  "${build_args[@]}"
}

build_server_bundle() {
  local architecture="$1"
  local platform="linux/$architecture"
  local expected_node_arch="$architecture"
  local bundle_path="$RELEASE_DIR/viron-server-$VERSION-linux-$architecture.tar.gz"
  local temporary_bundle="$bundle_path.tmp"
  local images=(
    "viron-server-lite:$VERSION"
    "viron-server-full:$VERSION"
    "viron-script-runner:$VERSION"
  )

  if [[ "$architecture" == "amd64" ]]; then
    expected_node_arch="x64"
  fi

  echo "正在构建 $platform 三种服务镜像..."
  echo "BuildKit 持久缓存：$DOCKER_CACHE_ROOT/release/$architecture"
  build_server_image "$architecture" full "viron-server-full:$VERSION"
  build_server_image "$architecture" lite "viron-server-lite:$VERSION"
  build_server_image "$architecture" script-runner "viron-script-runner:$VERSION"

  for image in "${images[@]}"; do
    local image_platform
    image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
    if [[ "$image_platform" != "$platform" ]]; then
      echo "$image 架构不匹配：期望 $platform，实际 $image_platform" >&2
      exit 1
    fi
  done

  for image in "viron-server-lite:$VERSION" "viron-server-full:$VERSION"; do
    local runtime_identity
    runtime_identity="$(docker run --rm --platform "$platform" --entrypoint node "$image" -e 'const manifest = require("/app/package.json"); process.stdout.write(`${manifest.version} ${process.arch}`)')"
    if [[ "$runtime_identity" != "$VERSION $expected_node_arch" ]]; then
      echo "$image 运行时版本或架构不匹配：$runtime_identity" >&2
      exit 1
    fi
  done
  local runner_architecture
  runner_architecture="$(docker run --rm --platform "$platform" --entrypoint node "viron-script-runner:$VERSION" -p 'process.arch')"
  if [[ "$runner_architecture" != "$expected_node_arch" ]]; then
    echo "viron-script-runner:$VERSION 运行时架构不匹配：$runner_architecture" >&2
    exit 1
  fi

  rm -f "$temporary_bundle"
  docker save "${images[@]}" | gzip -9 -n > "$temporary_bundle"
  gzip -t "$temporary_bundle"
  verify_bundle_tags "$temporary_bundle"
  mv "$temporary_bundle" "$bundle_path"
  echo "服务镜像离线包：${bundle_path#$ROOT_DIR/}"
}

build_server_bundle amd64
build_server_bundle arm64

expected_artifacts=(
  "$RELEASE_DIR/viron-server-$VERSION-linux-amd64.tar.gz"
  "$RELEASE_DIR/viron-server-$VERSION-linux-arm64.tar.gz"
  "$RELEASE_DIR/Viron-$VERSION-macos-arm64-self-signed.dmg"
  "$RELEASE_DIR/Viron-$VERSION-macos-x64-self-signed.dmg"
  "$RELEASE_DIR/Viron-$VERSION-windows-x86-unsigned-setup.exe"
  "$RELEASE_DIR/Viron-$VERSION-windows-x64-unsigned-setup.exe"
  "$RELEASE_DIR/Viron-$VERSION-windows-arm64-unsigned-setup.exe"
)

for artifact in "${expected_artifacts[@]}"; do
  if [[ ! -s "$artifact" ]]; then
    echo "缺少发布产物：${artifact#$ROOT_DIR/}" >&2
    exit 1
  fi
done

for artifact in "$RELEASE_DIR"/Viron-*-macos-*-self-signed.dmg \
  "$RELEASE_DIR"/Viron-*-windows-*-unsigned-setup.exe \
  "$RELEASE_DIR"/viron-server-*-linux-*.tar.gz; do
  [[ -e "$artifact" ]] || continue
  keep=false
  for expected in "${expected_artifacts[@]}"; do
    if [[ "$artifact" == "$expected" ]]; then
      keep=true
      break
    fi
  done
  if [[ "$keep" == false ]]; then
    rm -f "$artifact"
  fi
done

find "$ROOT_DIR/dist/macos" -mindepth 1 -maxdepth 1 -type d \
  ! -name Viron-darwin-arm64 ! -name Viron-darwin-x64 -exec rm -rf {} +
find "$ROOT_DIR/dist/windows" -mindepth 1 -maxdepth 1 -type d \
  ! -name ia32 ! -name x64 ! -name arm64 -exec rm -rf {} +

cat > "$RELEASE_DIR/README.md" <<EOF
# Viron $VERSION 发布产物

本次发布提供 \`linux/amd64\`、\`linux/arm64\` 服务镜像离线包和全平台桌面客户端安装包：

- \`viron-server-$VERSION-linux-amd64.tar.gz\`：包含 Lite、Full 与 Script Runner 的 Linux AMD64 Docker 镜像。
- \`viron-server-$VERSION-linux-arm64.tar.gz\`：包含 Lite、Full 与 Script Runner 的 Linux ARM64 Docker 镜像。
- \`Viron-$VERSION-macos-arm64-self-signed.dmg\`：macOS 12+、Apple Silicon \`arm64\` 的自签名安装盘。
- \`Viron-$VERSION-macos-x64-self-signed.dmg\`：macOS 12+、Intel \`x64\` 的自签名安装盘。
- \`Viron-$VERSION-windows-x86-unsigned-setup.exe\`：Windows Intel/AMD 32 位 \`x86\` 的未签名 NSIS 安装包。
- \`Viron-$VERSION-windows-x64-unsigned-setup.exe\`：Windows Intel/AMD 64 位 \`x64\` 的未签名 NSIS 安装包。
- \`Viron-$VERSION-windows-arm64-unsigned-setup.exe\`：Windows ARM64 的未签名 NSIS 安装包。
- \`SHA256SUMS\`：全部发布产物的 SHA-256 完整性校验。

每个服务离线包都包含同版本的 \`viron-server-lite:$VERSION\`、\`viron-server-full:$VERSION\` 和 \`viron-script-runner:$VERSION\`。只应在匹配 CPU 架构的 Linux 主机上加载对应离线包。

校验：

\`\`\`bash
cd Viron 项目根目录
shasum -a 256 -c release/SHA256SUMS
\`\`\`

Web 手工下载与 App 登录前自动更新共同扫描 \`DATA_DIR/installers/\`。把需要发布的当前版本客户端安装包复制到该目录即可；macOS arm64/x64 与 Windows x86/x64/arm64 都会同时进入 Web 清单和自动更新，无需配置独立安装包路径。

服务只发布文件名版本与当前产品版本一致、平台和架构可识别、位于目录根层且非空的普通 \`.dmg/.exe\` 文件。其他版本或无法识别的文件可以保留，但不会作为当前版本下发；目录内容变化在下次请求时生效，无需重启服务。

macOS DMG 使用 \`Viron Local Development\` 自签名证书与 Hardened Runtime，适合受控内部分发，但没有 Apple 公证。Windows 安装包未签名，可能触发 SmartScreen；macOS 构建机完成各 Windows 目标架构、NSIS 格式和包内运行文件检查，不替代真实 Windows 上的跨版本覆盖安装与启动验收。
EOF

checksum_file="$RELEASE_DIR/SHA256SUMS"
temporary_checksum="$checksum_file.tmp"
: > "$temporary_checksum"
for artifact in "${expected_artifacts[@]}"; do
  relative_artifact="${artifact#$ROOT_DIR/}"
  shasum -a 256 "$relative_artifact" >> "$temporary_checksum"
done
mv "$temporary_checksum" "$checksum_file"
shasum -a 256 -c "$checksum_file"

echo
echo "Viron $VERSION 发布产物已完成："
for artifact in "${expected_artifacts[@]}"; do
  du -h "$artifact"
done

trap - EXIT
