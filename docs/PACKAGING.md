# 增量打包

把依赖环境准备与日常发布分开。Base 包含 Node/Go 工具链、npm/Go 依赖、Chromium、字体和系统工具，不包含 Viron 业务源码，也不随发布版本号变化。

## 1. 一次准备 Base

```bash
# 默认同时准备 AMD64、ARM64 的运行环境及本机构建工具
bash scripts/package-base.sh
# 等价入口
npm run package:base

# 可只准备一个目标架构
bash scripts/package-base.sh --arch=amd64

# 准备后导出可加载的 Base 镜像包
bash scripts/package-base.sh --export=release/viron-base.tar.gz
# 在同种构建机架构上恢复 Base
# Go 工具链按构建机架构准备，运行环境按目标架构分别准备
docker load -i release/viron-base.tar.gz
```

准备阶段需要网络，下载一次并保存带标签的本地镜像。再次执行准备命令时只补充缺失或依赖已变化的 Base。导出文件包含所选目标架构的运行环境和当前构建机架构的编译环境；例如 ARM64 构建机导出的包可在另一台 ARM64 构建机上加载并生成两个目标架构的应用。换成 AMD64 构建机时，还需要准备其原生 Go 构建 Base。

服务打包使用当前 Docker context 的 `docker` 驱动 Buildx builder，Docker Desktop 默认满足要求。用 `docker buildx ls` 查看；`docker-container`/远程 builder 无法直接读取本地 Docker Engine 的 Base 标签，需要先选择 `docker` 驱动，例如 `docker buildx use default`。

## 2. 日常只编译代码

```bash
# 仅打三个服务镜像
npm run package:server -- --arch=arm64
npm run package:server -- --arch=amd64

# 完整发布矩阵：五种桌面安装包、两个服务离线包
bash scripts/package-release.sh

# 只打当前机器的桌面安装包
npm run package:current-os
```

`package-release.sh` 在验证源码和打桌面包之前，先检查两个目标架构的 Base 是否齐全。缺少 Base 会立即退出并给出准备命令，**不会在发布中途安装系统依赖**。

日常服务打包使用独立的 `docker/Dockerfile.application`，其中没有 apt/npm/Go 依赖安装步骤。业务源码以只读目录挂载到编译阶段，Node 和 Go 编译阶段都禁用网络，只把编译结果装入应用镜像。监控程序源码和真实版本号也在此阶段编译，不进入 Base。

| 变化 | 是否重新准备 Base |
| --- | --- |
| 业务源码、监控源码、发布版本号 | 否，只重新编译受影响的代码 |
| npm 依赖/锁文件、安装相关 package.json 配置 | 只更新 npm Base |
| Go 的 go.mod/go.sum | 只更新 Go Base |
| Chromium/系统库安装配方、APT 镜像源 | 只更新相关系统 Base |
| 目标架构 | 为该架构单独准备，防止原生依赖混用 |

需要更新上游 Node/Go 或系统安全补丁时显式刷新：

```bash
bash scripts/package-base.sh --refresh-docker-cache
# 兼容原入口：明确刷新后再发布
bash scripts/package-release.sh --refresh-docker-cache
```

Base 使用内容摘要标签保存在本地 Docker 镜像库。BuildKit 缓存清理不会删除带标签的 Base；`docker image prune -a` 或手动删除镜像后，需要重新加载导出的包或重新准备。旧 `.tmp/docker-build-cache/release/` 缓存仅用于首次准备时的迁移，支持 `VIRON_DOCKER_CACHE_DIR`。日常不再反复导出数 GB 的 `mode=max` 缓存。

默认 APT 使用 HTTPS 阿里云镜像，可通过 `VIRON_APT_MIRROR`、`VIRON_APT_SECURITY_MIRROR` 覆盖；容器镜像源通过 `VIRON_DOCKER_REGISTRY_MIRROR` 覆盖。保留 TLS 与 Debian 软件包签名/校验。编译步骤禁用网络，但 Docker BuildKit 仍可能解析 Dockerfile frontend 元数据，不承诺整个 Docker 命令完全离线。

`docker compose build` 保留根目录 Dockerfile 的完整构建能力，可能安装依赖。日常使用 `package:server` 生成镜像，再执行 `docker compose up -d`。

## 桌面端与压缩

macOS/全平台入口按依赖、Node 版本/ABI、平台与架构复用 node_modules。首次建立缓存后，版本号变化不重装依赖；命中时仍检查 Electron。强制重置命令：`node scripts/ensure-package-dependencies.mjs --force`。

五种桌面包共享编译结果。源码、配置、依赖、环境或输出文件内容变化时会重新编译；安装包仍重新组装、签名并校验。

离线包默认 gzip 级别 1，安装 pigz 时使用并行压缩；`VIRON_RELEASE_GZIP_LEVEL=9` 可恢复最高压缩率。编译、镜像导出和离线包压缩仍需要时间，日志会分别显示 `[Base 命中]`、`[构建缓存命中]`、`[耗时]`。
