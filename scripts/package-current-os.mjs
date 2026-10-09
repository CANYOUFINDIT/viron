import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");

export function currentDesktopPackageCommand(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") {
    return { command: "bash", args: ["scripts/package-macos.sh", "--arch=arm64"] };
  }
  if (platform === "win32" && (arch === "ia32" || arch === "x64")) {
    return { command: process.execPath, args: ["scripts/package-windows.mjs", "--arch=ia32"] };
  }
  return null;
}

export function packageCurrentOs(platform = process.platform, arch = process.arch) {
  const command = currentDesktopPackageCommand(platform, arch);
  if (!command) {
    process.stderr.write("当前系统或架构不支持桌面 App 打包。Viron 桌面端只提供 Apple Silicon macOS arm64 和 Windows x86（32 位 ia32）安装包；Windows x64 构建机也生成 x86 安装包。\n");
    return 1;
  }
  const result = spawnSync(command.command, command.args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`${result.error.stack ?? result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(packageCurrentOs());
}
