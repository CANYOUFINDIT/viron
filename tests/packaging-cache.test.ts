import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { baseImagePlan, imageMatchesPlatform, packageServer } from "../scripts/package-server.mjs";
import { dependencyKey, ensurePackageDependencies } from "../scripts/ensure-package-dependencies.mjs";
import { fingerprintFiles } from "../scripts/build-fingerprint.mjs";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const manifest = { name: "test", version: "1.0.0", dependencies: { example: "1.0.0" } };
const lock = { version: "1.0.0", packages: { "": manifest, "node_modules/example": { version: "1.0.0", integrity: "old" } } };
const input = { dockerfile, manifest, lock, normalizer: "v1", monitor: "monitor source", monitorScript: "monitor script", architecture: "arm64", builderArchitecture: "arm64", registry: "docker.io", apt: "mirror", aptSecurity: "security" };
const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
const images = (options = input) => Object.fromEntries(baseImagePlan(options).map((base) => [base.target, base.image]));

describe("packaging Base invalidation", () => {
  it("reuses npm/system Bases on release version and application code changes", () => {
    const before = images();
    const changed = images({ ...input, manifest: { ...manifest, version: "2.0.0" }, lock: { ...lock, version: "2.0.0", packages: { ...lock.packages, "": { ...manifest, version: "2.0.0" } } } });
    for (const target of ["dependencies", "production-dependencies", "server-runtime", "full-runtime", "script-runner-runtime"]) expect(changed[target]).toBe(before[target]);
    expect(changed["monitor-artifacts"]).not.toBe(before["monitor-artifacts"]);
    expect(images({ ...input, dockerfile: dockerfile.replace("RUN npm run build", "RUN npm run build && echo new-app") })).toEqual(before);
  });
  it("invalidates dependencies on transitive integrity changes, and separates target architectures", () => {
    const changed = images({ ...input, lock: { ...lock, packages: { ...lock.packages, "node_modules/example": { version: "1.0.0", integrity: "new" } } } });
    expect(changed.dependencies).not.toBe(images().dependencies);
    expect(changed["production-dependencies"]).not.toBe(images()["production-dependencies"]);
    expect(changed["full-runtime"]).toBe(images()["full-runtime"]);
    const cross = images({ ...input, architecture: "amd64" });
    expect(cross.dependencies).not.toBe(images().dependencies);
    expect(cross["monitor-artifacts"]).toBe(images()["monitor-artifacts"]);
    expect(images({ ...input, apt: "new-mirror" })["full-runtime"]).not.toBe(images()["full-runtime"]);
    expect(images({ ...input, monitor: "new monitor" })["monitor-artifacts"]).not.toBe(images()["monitor-artifacts"]);
  });
  it("accepts both Docker image metadata formats and rejects wrong architectures", () => {
    expect(imageMatchesPlatform({ Os: "linux", Architecture: "arm64" }, "arm64")).toBe(true);
    expect(imageMatchesPlatform({ Descriptor: { platform: { os: "linux", architecture: "amd64" } } }, "amd64")).toBe(true);
    expect(imageMatchesPlatform({ Os: "linux", Architecture: "amd64" }, "arm64")).toBe(false);
  });
  it("creates missing Bases once, then only builds three application images; refresh rebuilds Bases", () => {
    const available = new Map<string, string>();
    const builds: string[][] = [];
    const execute = (_command: string, args: string[]) => {
      if (args[0] === "buildx" && args[1] === "inspect") return { status: 0, stdout: "Driver: docker\n" };
      if (args[0] === "image") {
        const arch = available.get(args.at(-1)!);
        return arch ? { status: 0, stdout: JSON.stringify([{ Os: "linux", Architecture: arch }]) } : { status: 1 };
      }
      builds.push(args);
      available.set(args[args.indexOf("--tag") + 1], args[args.indexOf("--platform") + 1].split("/")[1]);
      return { status: 0 };
    };
    packageServer({ architecture: "arm64", execute, env: {}, baseOnly: true });
    expect(builds).toHaveLength(6);
    builds.length = 0;
    packageServer({ architecture: "arm64", execute, env: {} });
    expect(builds.map((args) => args[args.indexOf("--target") + 1])).toEqual(["full", "lite", "script-runner"]);
    expect(builds.every((args) => !args.includes("--no-cache") && !args.includes("--cache-to"))).toBe(true);
    builds.length = 0;
    packageServer({ architecture: "arm64", execute, env: {}, refresh: true, baseOnly: true });
    expect(builds).toHaveLength(6);
    expect(builds.every((args) => args.includes("--no-cache"))).toBe(true);
    expect(builds.find((args) => args.includes("production-dependencies"))).not.toContain("--pull");
  });
  it("stops on a failed Docker build", () => {
    expect(() => packageServer({ architecture: "arm64", env: {}, execute: (_: string, args: string[]) => args[1] === "inspect" && args[0] === "buildx" ? { status: 0, stdout: "Driver: docker\n" } : { status: 1, stderr: "failed" } })).toThrow("失败");
  });
});

describe("desktop dependency and build caches", () => {
  it("ignores release version but invalidates Node ABI and dependencies", () => {
    const key = dependencyKey(manifest, lock, { abi: "1" });
    expect(dependencyKey({ ...manifest, version: "2.0.0" }, { ...lock, version: "2.0.0" }, { abi: "1" })).toBe(key);
    expect(dependencyKey(manifest, lock, { abi: "2" })).not.toBe(key);
  });
  it("skips npm ci only after a successful install and detects missing packages", () => {
    const root = mkdtempSync(join(tmpdir(), "viron-dependency-test-")); temps.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
    let installs = 0;
    const execute = (command: string) => {
      if (command === "npm" || command === "npm.cmd") {
        installs++;
        mkdirSync(join(root, "node_modules/example"), { recursive: true });
        writeFileSync(join(root, "node_modules/example/package.json"), "{}");
        writeFileSync(join(root, "node_modules/.package-lock.json"), JSON.stringify(lock));
      }
      return { status: 0 };
    };
    ensurePackageDependencies({ root, execute });
    ensurePackageDependencies({ root, execute });
    expect(installs).toBe(1);
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...manifest, version: "2.0.0" }));
    ensurePackageDependencies({ root, execute });
    expect(installs).toBe(1);
    rmSync(join(root, "node_modules/example"), { recursive: true });
    ensurePackageDependencies({ root, execute });
    expect(installs).toBe(2);
    expect(() => ensurePackageDependencies({ root, force: true, execute: () => ({ status: 1 }) })).toThrow("依赖同步失败");
    ensurePackageDependencies({ root, execute });
    expect(installs).toBe(3);
  });
  it("detects changed, deleted and renamed build inputs/outputs", () => {
    const root = mkdtempSync(join(tmpdir(), "viron-fingerprint-test-")); temps.push(root);
    mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist/app.js"), "first");
    const first = fingerprintFiles(root, ["dist"]);
    expect(fingerprintFiles(root, ["dist"])).toBe(first);
    writeFileSync(join(root, "dist/app.js"), "second");
    expect(fingerprintFiles(root, ["dist"])).not.toBe(first);
    rmSync(join(root, "dist/app.js")); writeFileSync(join(root, "dist/new.js"), "first");
    expect(fingerprintFiles(root, ["dist"])).not.toBe(first);
    rmSync(join(root, "dist"), { recursive: true });
    expect(fingerprintFiles(root, ["dist"])).not.toBe(first);
  });
});
