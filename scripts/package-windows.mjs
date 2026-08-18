import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { Arch, Platform, build } from "electron-builder";
import { createAppIconPng } from "./app-icon.mjs";
import { buildDesktop, electronVersion, packageJson, root, stageDesktopApplication } from "./desktop-package.mjs";

const requestedArch = process.argv.find((argument) => argument.startsWith("--arch="))?.slice("--arch=".length) ?? "ia32";
const architectures = {
  ia32: { builder: Arch.ia32, label: "x86", executablePattern: /PE32 executable.*Intel 80386/i },
  x64: { builder: Arch.x64, label: "x64", executablePattern: /PE32\+ executable.*x86-64/i },
  arm64: { builder: Arch.arm64, label: "arm64", executablePattern: /PE32\+ executable.*Aarch64/i },
};
const architecture = architectures[requestedArch];
if (!architecture) throw new Error("Windows App 架构只支持 ia32、x64 或 arm64");
const nsisInstallerPattern = /PE32 executable.*Intel 80386.*Nullsoft Installer/i;

const outputDir = join(root, "dist", "windows", requestedArch);
const releaseDir = join(root, "release");
const artifactName = `Viron-${packageJson.version}-windows-${architecture.label}-unsigned-setup.exe`;
const releasePath = join(releaseDir, artifactName);

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

async function findUnpackedDirectory() {
  for (const entry of await readdir(outputDir)) {
    const path = join(outputDir, entry);
    if (entry.startsWith("win") && entry.endsWith("unpacked") && (await stat(path)).isDirectory()) return path;
  }
  throw new Error("没有找到 Windows 解包目录");
}

function verifyExecutableArchitecture(path, label) {
  const description = run("file", ["-b", path]).trim();
  if (!architecture.executablePattern.test(description)) {
    throw new Error(`${label}架构不匹配：${description}`);
  }
  return description;
}

function verifyNsisInstaller(path) {
  const description = run("file", ["-b", path]).trim();
  if (!nsisInstallerPattern.test(description)) {
    throw new Error(`Windows 安装包不是有效的 NSIS 启动程序：${description}`);
  }
  return description;
}

function verifyApplicationArchive(unpackedDir) {
  const archivePath = join(unpackedDir, "resources", "app.asar");
  if (!existsSync(archivePath)) throw new Error("Windows App 缺少 resources/app.asar");
  const asarCli = join(root, "node_modules", "@electron", "asar", "bin", "asar.js");
  const entries = run(process.execPath, [asarCli, "list", archivePath]);
  for (const required of [
    "/dist/desktop/main.js",
    "/dist/desktop/mcp-stdio.js",
    "/dist/desktop/preload.cjs",
    "/dist/desktop/immersive-navigation-preload.cjs",
    "/dist/desktop/agent-launcher-preload.cjs",
    "/dist/desktop/connection-quality-preload.cjs",
    "/dist/desktop/active-environment-dock-preload.cjs",
    "/dist/desktop/update-preload.cjs",
    "/dist/desktop-renderer/index.html",
    "/dist/desktop-renderer/desktop-immersive-navigation.html",
    "/dist/desktop-renderer/desktop-agent-launcher.html",
    "/dist/desktop-renderer/desktop-agent-chat.html",
    "/dist/desktop-renderer/desktop-connection-quality.html",
    "/dist/desktop-renderer/desktop-active-environment-dock.html",
    "/dist/desktop-renderer/desktop-update.html",
    "/node_modules/@earendil-works/pi-agent-core/package.json",
    "/node_modules/@earendil-works/pi-ai/package.json",
    "/node_modules/zod/package.json",
    "/node_modules/ssh2/package.json",
    "/node_modules/mysql2/package.json",
    "/node_modules/ioredis/package.json",
    "/node_modules/exceljs/package.json",
  ]) {
    if (!entries.includes(required)) throw new Error(`Windows App 缺少运行文件 ${required}`);
  }
}

async function verifyMcpLauncher(unpackedDir) {
  const launcher = join(unpackedDir, "viron-mcp.cmd");
  const content = await readFile(launcher, "utf8");
  if (!content.includes("ELECTRON_RUN_AS_NODE=1") || !content.includes("mcp-stdio.js")) {
    throw new Error("Windows App 的 viron-mcp.cmd 内容无效");
  }
}

buildDesktop();
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });
let stage;
let appIcon;

try {
  appIcon = await createAppIconPng(root);
  stage = await stageDesktopApplication("viron-windows-package-");
  await writeFile(join(stage, "viron-mcp.cmd"), "@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n\"%~dp0Viron.exe\" \"%~dp0resources\\app.asar\\dist\\desktop\\mcp-stdio.js\" %*\r\n", "utf8");
  const artifacts = await build({
    projectDir: stage,
    targets: Platform.WINDOWS.createTarget(["nsis"], architecture.builder),
    config: {
      appId: "com.viron.desktop",
      productName: "Viron",
      electronVersion,
      artifactName,
      compression: "maximum",
      asar: true,
      npmRebuild: false,
      nodeGypRebuild: false,
      directories: { output: outputDir },
      files: ["dist/**/*", "node_modules/**/*", "package.json"],
      extraFiles: [{ from: "viron-mcp.cmd", to: "viron-mcp.cmd" }],
      win: {
        icon: appIcon.icon,
        executableName: "Viron",
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: "Viron",
        uninstallDisplayName: "Viron",
        deleteAppDataOnUninstall: false,
      },
    },
  });

  const installerPath = artifacts.find((path) => basename(path) === artifactName);
  if (!installerPath) throw new Error(`没有找到 Windows 安装包 ${artifactName}`);
  const unpackedDir = await findUnpackedDirectory();
  const appExecutable = join(unpackedDir, "Viron.exe");
  const appDescription = verifyExecutableArchitecture(appExecutable, "Windows App ");
  const installerDescription = verifyNsisInstaller(installerPath);
  verifyApplicationArchive(unpackedDir);
  await verifyMcpLauncher(unpackedDir);

  if (installerPath !== releasePath) await cp(installerPath, releasePath);
  process.stdout.write([
    "",
    `Windows App: ${relative(root, appExecutable)}`,
    `安装包: ${relative(root, releasePath)}`,
    `架构: ${requestedArch} (${architecture.label})`,
    `App 文件: ${appDescription}`,
    `安装包文件: ${installerDescription}`,
    "签名: 未签名，Windows 可能显示 SmartScreen 提示",
    "运行验证: 需在真实 Windows 上完成",
    "",
  ].join("\n"));
} finally {
  if (stage) await rm(stage, { recursive: true, force: true });
  if (appIcon) await rm(appIcon.directory, { recursive: true, force: true });
}
