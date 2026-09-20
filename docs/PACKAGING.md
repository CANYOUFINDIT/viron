# 增量打包

日常打包使用以下入口：

```bash
# 当前机器的桌面安装包
npm run package:current-os

# 只构建一个架构的 Full、Lite、Script Runner 服务镜像
npm run package:server -- --arch=arm64
npm run package:server -- --arch=amd64

# 提前准备 Base，不构建应用镜像
npm run package:server -- --arch=arm64 --base-only

# 全平台发布：客户端、两个服务端架构、离线包和校验清单
npm run package:release
```

## Base 如何复用

服务打包使用当前 Docker context 的 `docker` 驱动 Buildx builder（可用 `docker buildx ls` 查看）。Docker Desktop 默认满足要求。`docker-container`/远程 builder 无法直接读取 Docker Engine 中的本地 Base 标签，需要先选择 `docker` 驱动 builder，例如 `docker buildx use default`。

第一次为每个架构建立本地 `viron-base-*` 镜像，之后直接基于这些镜像叠加最新代码。Base 标签包含内容摘要和架构，避免把 ARM 的原生依赖混入 AMD64 镜像。

| Base | 何时重建 |
| --- | --- |
| Node 服务运行环境 | 运行环境配方、镜像源或架构变化 |
| npm 构建依赖与生产依赖 | package.json（版本号除外）、锁文件中的依赖、归一化脚本、配方或架构变化 |
| Chromium、字体及系统库 | 系统依赖配方、APT 源、运行环境或架构变化 |
| Script Runner 运行环境 | 系统依赖配方、APT 源或架构变化 |
| 监控程序产物 | monitor 源码、构建脚本、版本号或 Go 配方变化 |

仅修改应用源码不会执行 npm/apt 安装。仅更新发布版本不会让 npm Base 失效；最终应用中仍写入真实的版本号。监控程序带有发布版本，因此版本变化时会重新编译。监控程序由构建机原生架构交叉编译，产物含两个 Linux 架构，两个服务镜像架构共享这份 Base。

Base 是带标签的本地 Docker 镜像，BuildKit 清理构建缓存后仍可复用；`docker image prune -a` 或手动删除对应镜像会使下次重新准备。首次创建时会尝试导入原 `.tmp/docker-build-cache/release/` 的缓存，`VIRON_DOCKER_CACHE_DIR` 可覆盖旧缓存根目录。日常发布不再为每个目标重复导出数 GB 的 `mode=max` 缓存。

上游 Node/Go 镜像与系统软件包通过显式刷新更新，不在每次打包时主动拉取。升级或修复基础依赖时运行：

```bash
npm run package:server -- --arch=arm64 --refresh-docker-cache
# 全平台刷新
npm run package:release -- --refresh-docker-cache
```

Base 缺失或刷新时需要网络；正常构建仍可能解析 Dockerfile frontend 元数据，不保证完全离线。默认 APT 使用 HTTPS 阿里云 Debian 镜像，支持 `VIRON_APT_MIRROR`、`VIRON_APT_SECURITY_MIRROR`；上游容器镜像支持 `VIRON_DOCKER_REGISTRY_MIRROR`。Node 自带的 CA 信任根用于首次 HTTPS APT 连接，随后安装系统 ca-certificates，保留 TLS 和 Debian 签名校验。

直接 `docker compose build` 仍可使用 Dockerfile 内置阶段和原 Compose 缓存；需要持久 Base 的快速打包时使用 `package:server`，之后执行 `docker compose up -d` 加载生成的同版本镜像。源代码改变时，独立的生产依赖层也不会再执行 npm prune。

## 桌面端与压缩

macOS/全平台入口根据依赖、Node 版本/ABI、操作系统和架构复用已安装的 node_modules；版本号变化不会触发重装。首次运行新脚本会安装一次以建立可信缓存。缓存命中时仍检查 Electron 可执行文件。需要重置时运行：

```bash
node scripts/ensure-package-dependencies.mjs --force
```

桌面编译根据源码、配置、依赖、环境与输出文件内容判断是否复用。同一次全平台发布的五种桌面包共享编译结果。修改或删除输入/输出会自动重建；安装包仍重新组装、签名并执行现有校验。

离线服务包默认使用 gzip 级别 1，已安装 pigz 时使用它进行并行压缩。文件通常略大，但生成更快；需要原来的最高压缩率时设置 `VIRON_RELEASE_GZIP_LEVEL=9`。日志中的 `[Base 命中]`、`[依赖缓存命中]`、`[构建缓存命中]` 和 `[耗时]` 可用于定位后续瓶颈。
