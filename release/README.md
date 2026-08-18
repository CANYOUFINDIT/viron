# Viron 0.1.6 发布产物

本次发布提供 `linux/amd64` 服务镜像离线包，以及 macOS、Windows 全架构桌面客户端安装包：

- `viron-server-0.1.6-linux-amd64.tar.gz`：包含 Lite、Full 与 Script Runner 的 Linux AMD64 Docker 镜像。
- `Viron-0.1.6-macos-arm64-self-signed.dmg`：macOS 12+、Apple Silicon `arm64` 的自签名安装盘。
- `Viron-0.1.6-macos-x64-self-signed.dmg`：macOS 12+、Intel `x64` 的自签名安装盘。
- `Viron-0.1.6-windows-x86-unsigned-setup.exe`：Windows `x86` 未签名安装包。
- `Viron-0.1.6-windows-x64-unsigned-setup.exe`：Windows `x64` 未签名安装包。
- `Viron-0.1.6-windows-arm64-unsigned-setup.exe`：Windows `arm64` 未签名安装包。
- `SHA256SUMS`：全部发布产物的 SHA-256 完整性校验。

服务离线包包含同版本的 `viron-server-lite:0.1.6`、`viron-server-full:0.1.6` 和 `viron-script-runner:0.1.6`。只应在 Linux AMD64 主机上加载该离线包。本次未生成 Linux ARM64 服务镜像包。

校验：

```bash
cd Viron 项目根目录
shasum -a 256 -c release/SHA256SUMS
```

Web 手工下载与 App 登录前自动更新共同扫描 `DATA_DIR/installers/`。把需要发布的当前版本客户端安装包复制到该目录即可；macOS arm64/x64 与 Windows x86/x64/arm64 都会同时进入 Web 清单和自动更新，无需配置独立安装包路径。

服务只发布文件名版本与当前产品版本一致、平台和架构可识别、位于目录根层且非空的普通 `.dmg/.exe` 文件。其他版本或无法识别的文件可以保留，但不会作为当前版本下发；目录内容变化在下次请求时生效，无需重启服务。

macOS DMG 使用 `Viron Local Development` 自签名证书与 Hardened Runtime，适合受控内部分发，但没有 Apple 公证。Windows 安装包未进行代码签名，安装时可能出现 SmartScreen 提示；其文件格式与目标架构已在 macOS 构建机上验证，实际启动仍需在对应架构的 Windows 环境中验收。
