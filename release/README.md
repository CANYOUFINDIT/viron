# Viron 0.1.6 发布产物

当前仓库默认发布范围：

| 文件 | 说明 |
| --- | --- |
| `viron-server-0.1.6-linux-amd64.tar.gz` | Lite、Full 与 Script Runner 的 Linux AMD64 镜像 |
| `Viron-0.1.6-macos-arm64-self-signed.dmg` | macOS 12+，Apple Silicon |
| `Viron-0.1.6-windows-x86-unsigned-setup.exe` | Windows x86 |
| `SHA256SUMS` | 上述文件的 SHA-256 校验清单 |

加载 Linux AMD64 离线镜像：

```bash
docker load -i release/viron-server-0.1.6-linux-amd64.tar.gz
docker compose -f docker-compose.full.yml up -d --no-build
```

校验：

```bash
shasum -a 256 -c release/SHA256SUMS
```

Web 下载与桌面客户端自动更新共同扫描服务端 `DATA_DIR/installers/`。把当前版本、平台和架构可识别的 `.dmg` / `.exe` 放到该目录根层即可。

macOS 安装包使用开发用自签名证书，未经 Apple 公证。Windows 安装包未代码签名，安装时可能出现 SmartScreen 提示。
