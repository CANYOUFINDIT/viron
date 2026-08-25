import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");

export function currentDesktopPackageCommand(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") {
    const macosArch = arch === "arm64" ? "arm64" : "x64";
    return { command: "bash", args: ["scripts/package-macos.sh", `--arch=${macosArch}`] };
  }
  if (platform === "win32") {
    const windowsArch = arch === "arm64" ? "arm64" : arch === "ia32" ? "ia32" : "x64";
    return { command: process.execPath, args: ["scripts/package-windows.mjs", `--arch=${windowsArch}`] };
  }
  return null;
}

export function packageCurrentOs(platform = process.platform, arch = process.arch) {
  const command = currentDesktopPackageCommand(platform, arch);
  if (!command) {
    process.stderr.write("当前操作系统没有对应的桌面 App 安装包。Viron 桌面端只提供 macOS 和 Windows 安装包。\n");
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
