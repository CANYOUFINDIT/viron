import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { desktopRuntimePackageRoots, desktopSourceRuntimePackages } from "../scripts/desktop-package.mjs";

const releaseScriptUrl = new URL("../scripts/package-release.sh", import.meta.url);
const versionScriptUrl = new URL("../scripts/sync-release-version.mjs", import.meta.url);
const desktopPackageUrl = new URL("../scripts/desktop-package.mjs", import.meta.url);
const windowsPackageUrl = new URL("../scripts/package-windows.mjs", import.meta.url);
const macosPackageUrl = new URL("../scripts/package-macos.mjs", import.meta.url);
const dockerfileUrl = new URL("../Dockerfile", import.meta.url);
const fullComposeUrl = new URL("../docker-compose.full.yml", import.meta.url);
const liteComposeUrl = new URL("../docker-compose.lite.yml", import.meta.url);

describe("release packaging", () => {
  it("builds every supported client and both three-image server bundles", () => {
    const source = readFileSync(releaseScriptUrl, "utf8");

    for (const command of [
      "package-macos.mjs --arch=arm64",
      "package-windows.mjs --arch=ia32",
      "build_server_bundle amd64",
      "build_server_bundle arm64",
    ]) {
      expect(source).toContain(command);
    }
    expect(source.match(/^node scripts\/package-(?:macos|windows)\.mjs --arch=.+$/gm)).toEqual([
      "node scripts/package-macos.mjs --arch=arm64",
      "node scripts/package-windows.mjs --arch=ia32",
    ]);
    const artifacts = source.match(/expected_artifacts=\([\s\S]*?\n\)/)?.[0] ?? "";
    expect(artifacts.match(/Viron-\$VERSION-[^"\n]+/g)).toEqual([
      "Viron-$VERSION-macos-arm64-self-signed.dmg",
      "Viron-$VERSION-windows-x86-unsigned-setup.exe",
    ]);
    for (const image of ["viron-server-lite", "viron-server-full", "viron-script-runner"]) {
      expect(source).toContain(image);
    }
    expect(source).toContain("shasum -a 256 -c");
    expect(source).toContain('relative_artifact="${artifact#$ROOT_DIR/}"');
    expect(source).toContain("for required_platform in linux/amd64 linux/arm64");
    expect(source.indexOf("ensure-package-dependencies.mjs")).toBeLessThan(source.indexOf("npm test"));
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts.test).toContain("ensure-electron.mjs");
  });

  it("exposes only the supported desktop targets through npm scripts", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(scripts["package:macos:arm64"]).toBe("bash scripts/package-macos.sh --arch=arm64");
    expect(scripts["package:windows:x86"]).toBe("node scripts/package-windows.mjs --arch=ia32");
    expect(scripts["package:windows:all"]).toBe("npm run package:windows:x86");
    expect(scripts["package:desktop:requested"]).toBe("npm run package:macos:arm64 && npm run package:windows:x86");
    for (const removed of ["package:macos:intel", "package:windows:x64", "package:windows:arm64"]) {
      expect(scripts[removed]).toBeUndefined();
    }
    const macosWrapper = readFileSync(new URL("../scripts/package-macos.sh", import.meta.url), "utf8");
    expect(macosWrapper).not.toContain("--arch=x64");
    expect(macosWrapper).toContain("exec node scripts/package-macos.mjs --arch=arm64");
  });

  it.each([
    [macosPackageUrl, "x64", "macOS App 只支持 Apple Silicon arm64"],
    [macosPackageUrl, "universal", "macOS App 只支持 Apple Silicon arm64"],
    [windowsPackageUrl, "x64", "Windows App 只支持 x86（32 位 ia32）"],
    [windowsPackageUrl, "arm64", "Windows App 只支持 x86（32 位 ia32）"],
    [windowsPackageUrl, "unknown", "Windows App 只支持 x86（32 位 ia32）"],
  ] as const)("rejects unsupported explicit package targets (%s %s)", (script, arch, message) => {
    const result = spawnSync(process.execPath, [script.pathname, `--arch=${arch}`], { encoding: "utf8", timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it("persists Docker build caches and supports explicit refreshes", () => {
    const releaseSource = readFileSync(new URL("../scripts/package-server.mjs", import.meta.url), "utf8");
    const dockerfileSource = readFileSync(dockerfileUrl, "utf8");

    expect(releaseSource).toContain("--refresh-docker-cache");
    expect(releaseSource).toContain("VIRON_DOCKER_CACHE_DIR");
    expect(releaseSource).toContain("VIRON_DOCKER_REGISTRY_MIRROR");
    expect(releaseSource).toContain('env.VIRON_DOCKER_REGISTRY_MIRROR || "docker.io"');
    expect(releaseSource).toContain("--cache-from");
    expect(releaseSource).not.toContain('args.push("--cache-to"');
    expect(releaseSource).toContain("mode=max");
    expect(releaseSource).toContain("--no-cache");

    expect(dockerfileSource).toContain("--mount=type=cache");
    expect(dockerfileSource).toContain("FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS monitor-dependencies");
    expect(dockerfileSource).toContain("FROM ${VIRON_SERVER_BASE} AS full-runtime");
    expect(dockerfileSource).toContain("FROM ${VIRON_FULL_APP_BASE} AS full");
    expect(dockerfileSource).toContain("COPY --from=server-base --chown=viron:viron /app/dist ./dist");
    expect(dockerfileSource).toContain("ELECTRON_SKIP_BINARY_DOWNLOAD=1");
    expect(dockerfileSource).not.toContain("COPY scripts ./scripts");

    for (const composeUrl of [fullComposeUrl, liteComposeUrl]) {
      const composeSource = readFileSync(composeUrl, "utf8");
      expect(composeSource).toContain("VIRON_DOCKER_CACHE_DIR");
      expect(composeSource).toContain("VIRON_DOCKER_REGISTRY_MIRROR");
      expect(composeSource).toContain('VIRON_DOCKER_REGISTRY_MIRROR:-docker.io');
      expect(composeSource).toContain("cache_from:");
      expect(composeSource).toContain("cache_to:");
      expect(composeSource).toContain("mode=max");
    }
  });

  it("packages the Pi Agent runtime instead of the removed Vercel AI SDK", () => {
    const desktopPackage = readFileSync(desktopPackageUrl, "utf8");
    const windowsPackage = readFileSync(windowsPackageUrl, "utf8");
    for (const dependency of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"]) {
      expect(desktopPackage).toContain(`"${dependency}"`);
      expect(windowsPackage).toContain(`/node_modules/${dependency}/package.json`);
    }
    for (const removed of ["@ai-sdk/anthropic", "@ai-sdk/openai-compatible", '"ai"']) {
      expect(desktopPackage).not.toContain(removed);
    }
    expect(desktopRuntimePackageRoots).toContain("yauzl");
    expect(windowsPackage).toContain("/node_modules/yauzl/package.json");
    expect(windowsPackage).toContain("/node_modules/pend/package.json");
    const runtimePackages = [...desktopSourceRuntimePackages()].sort();
    expect(runtimePackages).toContain("yauzl");
    expect(runtimePackages.filter((name) => !desktopRuntimePackageRoots.includes(name))).toEqual([]);
  });

  it("documents the default version and exits without building for help", () => {
    const result = spawnSync("bash", [releaseScriptUrl.pathname, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("./scripts/package-release.sh [--refresh-docker-cache] [version]");
    expect(result.stdout).toContain("When version is omitted, package.json version is used.");
    expect(result.stdout).toContain("Normal releases never install container dependencies");
  });

  it("accepts the current version without editing and rejects Docker-incompatible versions", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const current = spawnSync(process.execPath, [versionScriptUrl.pathname, packageJson.version], { encoding: "utf8" });
    expect(current.status).toBe(0);
    expect(current.stdout).toContain(`发布版本保持 ${packageJson.version}`);

    const invalid = spawnSync(process.execPath, [versionScriptUrl.pathname, `${packageJson.version}+build.1`], { encoding: "utf8" });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("版本号必须是可用于 Docker 标签的 SemVer");
  });
});
