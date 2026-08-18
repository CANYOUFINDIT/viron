import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import packager from "@electron/packager";
import { createAppIconPng } from "./app-icon.mjs";
import { buildDesktop, electronVersion, packageJson, root, stageDesktopApplication } from "./desktop-package.mjs";
import { pkcs12ExportArgs, resolveOpenSslCommand, supportsPkcs12Legacy } from "./macos-openssl.mjs";

const requestedArch = process.argv.find((argument) => argument.startsWith("--arch="))?.slice("--arch=".length);
const arch = requestedArch ?? (process.arch === "arm64" ? "arm64" : "x64");
if (arch !== "arm64" && arch !== "x64") throw new Error("macOS App 架构只支持 arm64 或 x64");
const minimumMacosVersion = "12.0.0";
const compatibilityTargetMacosVersion = "12.7.6";
const outputDir = join(root, "dist", "macos");
const architectureOutputDir = join(outputDir, `Viron-darwin-${arch}`);
const releaseDir = join(root, "release");
const dmgPath = join(releaseDir, `Viron-${packageJson.version}-macos-${arch}-self-signed.dmg`);
const dmgBackgroundSource = join(root, "design", "dmg-background.svg");
const entitlements = join(root, "src", "desktop", "entitlements.plist");
const identityName = "Viron Local Development";
const signingDirectory = join(homedir(), "Library", "Application Support", "Viron Development", "macos-signing");
const persistentKeychain = join(signingDirectory, "VironLocalDevelopment.keychain-db");
const keychainPasswordFile = join(signingDirectory, "keychain-password");
const opensslCommand = resolveOpenSslCommand();
const opensslLegacyPkcs12 = supportsPkcs12Legacy(opensslCommand);

function run(command, args, options = {}) {
  const captureOutput = options.capture || options.input !== undefined;
  return execFileSync(command, args, {
    encoding: "utf8",
    input: options.input,
    stdio: captureOutput ? "pipe" : "inherit",
  });
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function keychains() {
  const output = run("security", ["list-keychains", "-d", "user"], { capture: true });
  return [...new Set([...output.matchAll(/"([^"]+)"/g)].map((match) => match[1]))];
}

async function createMacosIcon() {
  const rasterIcon = await createAppIconPng(root);
  const { directory } = rasterIcon;
  const iconset = join(directory, "Viron.iconset");
  const icon = join(directory, "Viron.icns");
  const sizes = [16, 32, 128, 256, 512];
  try {
    await mkdir(iconset, { recursive: true });
    for (const size of sizes) {
      run("sips", [
        "-z", String(size), String(size),
        rasterIcon.icon,
        "--out", join(iconset, `icon_${size}x${size}.png`),
      ], { capture: true });
      run("sips", [
        "-z", String(size * 2), String(size * 2),
        rasterIcon.icon,
        "--out", join(iconset, `icon_${size}x${size}@2x.png`),
      ], { capture: true });
    }
    run("iconutil", ["-c", "icns", iconset, "-o", icon], { capture: true });
    return { directory, icon };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function verifyPackagedApplication(appPath) {
  const mcpExecutable = join(appPath, "Contents", "MacOS", "viron-mcp");
  const mcpStat = await lstat(mcpExecutable);
  const mcpDescription = run("file", [mcpExecutable], { capture: true });
  const mcpStrings = run("strings", [mcpExecutable], { capture: true });
  if ((mcpStat.mode & 0o111) === 0 || !mcpDescription.includes("Mach-O 64-bit executable") || !mcpStrings.includes("ELECTRON_RUN_AS_NODE") || !mcpStrings.includes("mcp-stdio.js")) {
    throw new Error("打包 App 的 viron-mcp 启动器无效");
  }
  const smokeDirectory = await mkdtemp(join(tmpdir(), "viron-macos-smoke-"));
  try {
    const executable = join(appPath, "Contents", "MacOS", "Viron");
    const result = spawnSync(executable, [`--user-data-dir=${smokeDirectory}`, "--smoke-test"], {
      cwd: dirname(executable),
      encoding: "utf8",
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: arch === process.arch ? 60_000 : 120_000,
    });
    if (result.status !== 0 || !result.stdout.includes("VIRON_DESKTOP_SMOKE")) {
      const diagnostics = [
        `status: ${result.status ?? "null"}`,
        `signal: ${result.signal ?? "none"}`,
        result.error ? `error: ${result.error.message}` : "",
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n");
      throw new Error(`打包 App 启动烟测失败\n${diagnostics}`);
    }
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true });
  }
}

async function verifyPortableApplicationSymlinks(appPath) {
  const symlinkOutput = run("find", [appPath, "-type", "l", "-print"], { capture: true });
  for (const path of symlinkOutput.split("\n").filter(Boolean)) {
    const target = await readlink(path);
    if (target.startsWith("/")) {
      throw new Error(`App 包含不可移植的绝对符号链接：${relative(appPath, path)} -> ${target}`);
    }
    const resolvedTarget = resolve(dirname(path), target);
    const relativeTarget = relative(appPath, resolvedTarget);
    if (relativeTarget === ".." || relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`App 符号链接指向包外：${relative(appPath, path)} -> ${target}`);
    }
    if (!existsSync(resolvedTarget)) {
      throw new Error(`App 包含失效符号链接：${relative(appPath, path)} -> ${target}`);
    }
  }
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function verifyPackagedCompatibility(appPath) {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  const declaredMinimum = run("plutil", ["-extract", "LSMinimumSystemVersion", "raw", infoPlist], { capture: true }).trim();
  if (declaredMinimum !== minimumMacosVersion) {
    throw new Error(`App 最低系统版本应为 ${minimumMacosVersion}，实际为 ${declaredMinimum || "未设置"}`);
  }
  const localNetworkUsage = run("plutil", ["-extract", "NSLocalNetworkUsageDescription", "raw", infoPlist], { capture: true }).trim();
  if (!localNetworkUsage) throw new Error("App 必须声明 macOS 本地网络访问用途");

  const expectedArchitecture = arch === "x64" ? "x86_64" : "arm64";
  const candidateOutput = run("find", [
    appPath,
    "-type", "f",
    "(", "-perm", "+111", "-o", "-name", "*.dylib", "-o", "-name", "*.node", ")",
    "-print",
  ], { capture: true });
  let checkedMachOFiles = 0;
  for (const path of candidateOutput.split("\n").filter(Boolean)) {
    if (!run("file", ["-b", path], { capture: true }).includes("Mach-O")) continue;
    const architectures = run("lipo", ["-archs", path], { capture: true }).trim().split(/\s+/);
    if (!architectures.includes(expectedArchitecture)) {
      throw new Error(`打包文件架构不匹配：${relative(appPath, path)} 缺少 ${expectedArchitecture}`);
    }
    checkedMachOFiles += 1;
  }
  if (!checkedMachOFiles) throw new Error("没有找到可验证架构的 macOS Mach-O 文件");

  const deploymentTargets = [
    join(appPath, "Contents", "MacOS", "Viron"),
    join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework"),
  ];
  for (const path of deploymentTargets) {
    const output = run("otool", ["-l", path], { capture: true });
    const versions = [...output.matchAll(/\bminos\s+([0-9.]+)/g)].map((match) => match[1]);
    if (!versions.length) throw new Error(`无法读取部署目标：${relative(appPath, path)}`);
    if (versions.some((version) => compareVersions(version, compatibilityTargetMacosVersion) > 0)) {
      throw new Error(`${relative(appPath, path)} 不能在 macOS ${compatibilityTargetMacosVersion} 运行`);
    }
  }

  process.stdout.write(`兼容性: ${expectedArchitecture} · macOS ${minimumMacosVersion}+ · 已检查 ${checkedMachOFiles} 个 Mach-O 文件\n`);
}

async function detachDiskImage(mountPoint) {
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8" });
    if (result.status === 0) return;
    lastError = result.stderr || result.stdout || `退出码 ${result.status}`;
    await wait(1_000);
  }
  throw new Error(`无法卸载临时 DMG：${lastError.trim()}`);
}

function configureDmgWindow(mountPoint) {
  const finderLayoutScript = `
on run argv
  set mountPath to item 1 of argv
  set volumeFolder to POSIX file mountPath as alias
  set backgroundFile to POSIX file (mountPath & "/.background/dmg-background.png") as alias

  tell application "Finder"
    open volumeFolder
    delay 1
    set dmgWindow to container window of volumeFolder
    set current view of dmgWindow to icon view
    set toolbar visible of dmgWindow to false
    set statusbar visible of dmgWindow to false
    set pathbar visible of dmgWindow to false
    set bounds of dmgWindow to {100, 100, 1020, 522}

    set viewOptions to icon view options of dmgWindow
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 96
    set text size of viewOptions to 13
    set background picture of viewOptions to backgroundFile

    set position of item "Viron.app" of volumeFolder to {245, 225}
    set position of item "Applications" of volumeFolder to {675, 225}
    update volumeFolder without registering applications
    delay 2
    close dmgWindow
  end tell
end run
`;
  run("osascript", ["-", mountPoint], { input: finderLayoutScript });
}

async function createDmg(appPath) {
  const volumeName = `Viron ${packageJson.version}`;
  const sourceDirectory = await mkdtemp(join(tmpdir(), "viron-dmg-source-"));
  const workDirectory = await mkdtemp(join(tmpdir(), "viron-dmg-work-"));
  const mountPoint = await mkdtemp(join(tmpdir(), "viron-dmg-mount-"));
  const writableDmg = join(workDirectory, "Viron-writable.dmg");
  const backgroundDirectory = join(sourceDirectory, ".background");
  let attached = false;

  try {
    await cp(appPath, join(sourceDirectory, "Viron.app"), { recursive: true, verbatimSymlinks: true });
    await symlink("/Applications", join(sourceDirectory, "Applications"));
    await mkdir(backgroundDirectory, { recursive: true });
    run("sips", [
      "-s", "format", "png",
      dmgBackgroundSource,
      "--out", join(backgroundDirectory, "dmg-background.png"),
    ], { capture: true });
    run("SetFile", ["-a", "V", backgroundDirectory], { capture: true });

    run("hdiutil", [
      "create",
      "-volname", volumeName,
      "-srcfolder", sourceDirectory,
      "-ov",
      "-format", "UDRW",
      "-fs", "HFS+",
      writableDmg,
    ]);
    run("hdiutil", [
      "attach",
      "-readwrite",
      "-noverify",
      "-noautoopen",
      "-mountpoint", mountPoint,
      writableDmg,
    ]);
    attached = true;
    configureDmgWindow(mountPoint);
    await rm(join(mountPoint, ".fseventsd"), { recursive: true, force: true });
    await rm(join(mountPoint, ".Trashes"), { recursive: true, force: true });
    await detachDiskImage(mountPoint);
    attached = false;

    await rm(dmgPath, { force: true });
    run("hdiutil", [
      "convert",
      writableDmg,
      "-format", "UDZO",
      "-imagekey", "zlib-level=9",
      "-o", dmgPath,
    ]);
  } finally {
    if (attached) {
      try { await detachDiskImage(mountPoint); } catch { /* Preserve the packaging error. */ }
    }
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(workDirectory, { recursive: true, force: true });
    await rm(mountPoint, { recursive: true, force: true });
  }
}

async function verifyDmg() {
  const mountPoint = await mkdtemp(join(tmpdir(), "viron-dmg-verify-"));
  let attached = false;
  try {
    run("hdiutil", ["verify", dmgPath]);
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath]);
    attached = true;

    const mountedAppPath = join(mountPoint, "Viron.app");
    if (!(await lstat(mountedAppPath)).isDirectory()) {
      throw new Error("DMG 中没有可安装的 Viron.app");
    }
    if (!(await lstat(join(mountPoint, "Applications"))).isSymbolicLink()
      || await readlink(join(mountPoint, "Applications")) !== "/Applications") {
      throw new Error("DMG 中没有指向 /Applications 的拖拽安装入口");
    }
    if (!(await lstat(join(mountPoint, ".background", "dmg-background.png"))).isFile()) {
      throw new Error("DMG 中没有安装引导背景");
    }
    if (!(await lstat(join(mountPoint, ".DS_Store"))).isFile()) {
      throw new Error("DMG 中没有 Finder 窗口布局");
    }
    await verifyPortableApplicationSymlinks(mountedAppPath);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", mountedAppPath]);
  } finally {
    if (attached) await detachDiskImage(mountPoint);
    await rm(mountPoint, { recursive: true, force: true });
  }
}

function findSigningIdentity(keychain) {
  try {
    const output = run("security", ["find-identity", "-v", "-p", "codesigning", keychain], { capture: true });
    return output.match(new RegExp(`\\)\\s+([0-9A-F]{40})\\s+"${identityName}"`))?.[1] ?? null;
  } catch {
    return null;
  }
}

async function createPersistentSigningIdentity() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "viron-macos-signing-"));
  const key = join(temporaryDirectory, "key.pem");
  const certificate = join(temporaryDirectory, "certificate.pem");
  const p12 = join(temporaryDirectory, "identity.p12");
  const password = randomBytes(24).toString("hex");
  let keychainCreated = false;
  try {
    await mkdir(signingDirectory, { recursive: true, mode: 0o700 });
    await chmod(signingDirectory, 0o700);
    await writeFile(keychainPasswordFile, `${password}\n`, { encoding: "utf8", mode: 0o600 });
    run(opensslCommand, [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
      "-keyout", key, "-out", certificate,
      "-subj", `/CN=${identityName}/O=Viron/C=CN`,
      "-addext", "basicConstraints=critical,CA:false",
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=codeSigning",
    ], { capture: true });
    run(opensslCommand, pkcs12ExportArgs({ output: p12, key, certificate, password, legacy: opensslLegacyPkcs12 }), { capture: true });
    run("security", ["create-keychain", "-p", password, persistentKeychain], { capture: true });
    keychainCreated = true;
    run("security", ["unlock-keychain", "-p", password, persistentKeychain], { capture: true });
    run("security", ["set-keychain-settings", "-lut", "21600", persistentKeychain], { capture: true });
    run("security", ["import", p12, "-k", persistentKeychain, "-P", password, "-T", "/usr/bin/codesign"], { capture: true });
    run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, persistentKeychain], { capture: true });
    run("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", persistentKeychain, certificate], { capture: true });
    const identity = findSigningIdentity(persistentKeychain);
    if (!identity) throw new Error("无法创建可用的 Viron 自签名身份");
    return { identity, identityName, keychain: persistentKeychain, created: true };
  } catch (error) {
    if (keychainCreated) {
      try { run("security", ["delete-keychain", persistentKeychain], { capture: true }); } catch { /* Best-effort cleanup. */ }
    }
    await rm(keychainPasswordFile, { force: true });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function recreatePersistentSigningIdentity() {
  process.stdout.write("Viron 本地签名钥匙串失效，正在自动重建...\n");
  if (existsSync(persistentKeychain)) {
    try {
      run("security", ["delete-keychain", persistentKeychain], { capture: true });
    } catch {
      await rm(persistentKeychain, { force: true });
    }
  }
  await rm(keychainPasswordFile, { force: true });
  return await createPersistentSigningIdentity();
}

async function signingIdentity(searchKeychains) {
  for (const keychain of searchKeychains) {
    if (resolve(keychain) === persistentKeychain) continue;
    const identity = findSigningIdentity(keychain);
    if (identity) return { identity, identityName, keychain, created: false };
  }

  const keychainExists = existsSync(persistentKeychain);
  const passwordExists = existsSync(keychainPasswordFile);
  if (keychainExists !== passwordExists) {
    return await recreatePersistentSigningIdentity();
  }
  if (!keychainExists) return await createPersistentSigningIdentity();

  const password = (await readFile(keychainPasswordFile, "utf8")).trim();
  if (!password) return await recreatePersistentSigningIdentity();
  try {
    run("security", ["unlock-keychain", "-p", password, persistentKeychain], { capture: true });
  } catch {
    return await recreatePersistentSigningIdentity();
  }
  run("security", ["set-keychain-settings", "-lut", "21600", persistentKeychain], { capture: true });
  run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, persistentKeychain], { capture: true });
  const identity = findSigningIdentity(persistentKeychain);
  if (!identity) return await recreatePersistentSigningIdentity();
  return { identity, identityName, keychain: persistentKeychain, created: false };
}

function sign(identity, path, includeEntitlements) {
  const args = ["--deep", "--force"];
  if (includeEntitlements) args.push("--options", "runtime", "--entitlements", entitlements);
  args.push("--sign", identity, "--timestamp=none", path);
  run("codesign", args);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", path]);
}

function compileMcpLauncher(appPath) {
  const source = join(root, "src", "desktop", "mcp-launcher.c");
  const output = join(appPath, "Contents", "MacOS", "viron-mcp");
  run("xcrun", [
    "clang",
    "-arch", arch === "x64" ? "x86_64" : "arm64",
    `-mmacosx-version-min=${minimumMacosVersion}`,
    "-Os",
    "-Wall",
    "-Wextra",
    "-Werror",
    source,
    "-o", output,
  ]);
}

if (process.platform !== "darwin") throw new Error("macOS 安装包只能在 macOS 上构建");

buildDesktop();
await rm(architectureOutputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });
let stage;
let macosIcon;
let signing;
const originalKeychains = keychains().filter((keychain) => resolve(keychain) !== persistentKeychain);

try {
  stage = await stageDesktopApplication("viron-macos-package-");
  macosIcon = await createMacosIcon();
  const packagedPaths = await packager({
    dir: stage,
    out: outputDir,
    overwrite: true,
    asar: true,
    platform: "darwin",
    arch,
    electronVersion,
    name: "Viron",
    executableName: "Viron",
    appBundleId: "com.viron.desktop",
    appVersion: packageJson.version,
    buildVersion: packageJson.version,
    icon: macosIcon.icon,
    extendInfo: {
      CFBundleDisplayName: "Viron",
      LSMinimumSystemVersion: minimumMacosVersion,
      NSHumanReadableCopyright: "Viron",
      NSLocalNetworkUsageDescription: "Viron 需要访问本地网络中的 Web、SSH、日志和数据库服务。",
    },
  });
  const appPath = packagedPaths.map((path) => join(path, "Viron.app")).find((path) => basename(path) === "Viron.app");
  if (!appPath) throw new Error("没有找到生成的 Viron.app");
  compileMcpLauncher(appPath);
  await verifyPortableApplicationSymlinks(appPath);
  verifyPackagedCompatibility(appPath);

  signing = await signingIdentity(originalKeychains);
  run("security", ["list-keychains", "-d", "user", "-s", signing.keychain, ...originalKeychains]);
  sign(signing.identity, appPath, true);
  await verifyPackagedApplication(appPath);

  await createDmg(appPath);
  sign(signing.identity, dmgPath, false);
  await verifyDmg();

  process.stdout.write(`\nmacOS App: ${appPath}\nDMG: ${dmgPath}\n架构: ${arch}\n最低系统: macOS ${minimumMacosVersion}\n签名: ${signing.identityName}（自签名，未公证，${signing.created ? "已创建并持久保存" : "已复用"}）\n`);
} finally {
  if (originalKeychains.length) run("security", ["list-keychains", "-d", "user", "-s", ...originalKeychains]);
  if (stage) await rm(stage, { recursive: true, force: true });
  if (macosIcon) await rm(macosIcon.directory, { recursive: true, force: true });
}
