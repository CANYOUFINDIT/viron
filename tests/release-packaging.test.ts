import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const releaseScriptUrl = new URL("../scripts/package-release.sh", import.meta.url);
const versionScriptUrl = new URL("../scripts/sync-release-version.mjs", import.meta.url);
const desktopPackageUrl = new URL("../scripts/desktop-package.mjs", import.meta.url);
const windowsPackageUrl = new URL("../scripts/package-windows.mjs", import.meta.url);
const dockerfileUrl = new URL("../Dockerfile", import.meta.url);
const fullComposeUrl = new URL("../docker-compose.full.yml", import.meta.url);
const liteComposeUrl = new URL("../docker-compose.lite.yml", import.meta.url);

describe("release packaging", () => {
  it("builds every supported client and both three-image server bundles", () => {
    const source = readFileSync(releaseScriptUrl, "utf8");

    for (const command of [
      "package-macos.mjs --arch=arm64",
      "package-macos.mjs --arch=x64",
      "package-windows.mjs --arch=ia32",
      "package-windows.mjs --arch=x64",
      "package-windows.mjs --arch=arm64",
      "build_server_bundle amd64",
      "build_server_bundle arm64",
    ]) {
      expect(source).toContain(command);
    }
    for (const image of ["viron-server-lite", "viron-server-full", "viron-script-runner"]) {
      expect(source).toContain(image);
    }
    expect(source).toContain("shasum -a 256 -c");
    expect(source).toContain('relative_artifact="${artifact#$ROOT_DIR/}"');
    expect(source).toContain("for required_platform in linux/amd64 linux/arm64");
    expect(source.indexOf('const electronPath = require("electron")')).toBeLessThan(source.indexOf("npm test"));
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts.test).toContain("ensure-electron.mjs");
  });

  it("persists Docker build caches and supports explicit refreshes", () => {
    const releaseSource = readFileSync(releaseScriptUrl, "utf8");
    const dockerfileSource = readFileSync(dockerfileUrl, "utf8");

    expect(releaseSource).toContain("--refresh-docker-cache");
    expect(releaseSource).toContain("VIRON_DOCKER_CACHE_DIR");
    expect(releaseSource).toContain("VIRON_DOCKER_REGISTRY_MIRROR");
    expect(releaseSource).toContain('VIRON_DOCKER_REGISTRY_MIRROR:-docker.io');
    expect(releaseSource).toContain("--cache-from");
    expect(releaseSource).toContain("--cache-to");
    expect(releaseSource).toContain("mode=max");
    expect(releaseSource).toContain("--no-cache");

    expect(dockerfileSource).toContain("--mount=type=cache");
    expect(dockerfileSource).toContain("FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS monitor-build");
    expect(dockerfileSource).toContain("FROM server-runtime AS full-runtime");
    expect(dockerfileSource).toContain("FROM full-runtime AS full");
    expect(dockerfileSource).toContain("COPY --from=server-base --chown=viron:viron /app/ /app/");
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
  });

  it("documents the default version and exits without building for help", () => {
    const result = spawnSync("bash", [releaseScriptUrl.pathname, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("./scripts/package-release.sh [--refresh-docker-cache] [version]");
    expect(result.stdout).toContain("When version is omitted, package.json version is used.");
    expect(result.stdout).toContain("project-local BuildKit cache");
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
