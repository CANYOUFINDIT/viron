import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { dependencyManifests } from "./dependency-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

export function stageRecipe(dockerfile, names) {
  return names.map((name) => {
    const stages = dockerfile.split(/(?=^FROM )/m);
    const stage = stages.find((entry) => new RegExp(`^FROM .+ AS ${name}\\s*$`, "m").test(entry));
    if (!stage) throw new Error(`Dockerfile 缺少阶段 ${name}`);
    return stage;
  }).join("\n");
}

function treeContents(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [
    entry.name,
    entry.isDirectory() ? treeContents(join(directory, entry.name)) : readFileSync(join(directory, entry.name), "utf8"),
  ]);
}

export function baseImagePlan({ dockerfile, manifest, lock, normalizer, monitor, monitorScript, architecture, registry, apt, aptSecurity, builderArchitecture = process.arch === "arm64" ? "arm64" : "amd64" }) {
  const image = (name, inputs) => `viron-base-${name}:${name === "monitor" ? builderArchitecture : architecture}-${hash(inputs)}`;
  const settings = { architecture, registry, schema: 1 };
  const dependencies = image("dependencies", [settings, stageRecipe(dockerfile, ["dependency-manifests", "dependencies"]), normalizer, dependencyManifests(manifest, lock)]);
  return [
    { target: "server-runtime", argument: "VIRON_SERVER_BASE", image: image("server", [settings, stageRecipe(dockerfile, ["server-runtime"])]) },
    { target: "dependencies", argument: "VIRON_BUILD_BASE", image: dependencies },
    { target: "production-dependencies", argument: "VIRON_PRODUCTION_BASE", image: image("production", [dependencies, stageRecipe(dockerfile, ["production-dependencies"])]) },
    { target: "full-runtime", argument: "VIRON_FULL_BASE", image: image("full", [settings, apt, aptSecurity, stageRecipe(dockerfile, ["server-runtime", "full-runtime"])]) },
    { target: "script-runner-runtime", argument: "VIRON_RUNNER_BASE", image: image("runner", [settings, apt, aptSecurity, stageRecipe(dockerfile, ["script-runner-runtime"])]) },
    { target: "monitor-artifacts", architecture: builderArchitecture, argument: "VIRON_MONITOR_BASE", image: image("monitor", [{ ...settings, architecture: builderArchitecture }, manifest.version, monitor, monitorScript, stageRecipe(dockerfile, ["monitor-build", "monitor-artifacts"])]) },
  ];
}

export function imageMatchesPlatform(image, architecture) {
  // Newer containerd stores may return only the OCI descriptor's platform.
  const platform = image.Descriptor?.platform;
  return (image.Os || platform?.os) === "linux" && (image.Architecture || platform?.architecture) === architecture;
}

export function packageServer({ architecture, refresh = false, baseOnly = false, projectRoot = root, env = process.env, execute = spawnSync }) {
  if (!["amd64", "arm64"].includes(architecture)) throw new Error("服务镜像架构只支持 amd64 或 arm64");
  const read = (path) => readFileSync(join(projectRoot, path), "utf8");
  const manifest = JSON.parse(read("package.json"));
  const registry = env.VIRON_DOCKER_REGISTRY_MIRROR || "docker.io";
  const apt = env.VIRON_APT_MIRROR || "https://mirrors.aliyun.com/debian";
  const aptSecurity = env.VIRON_APT_SECURITY_MIRROR || "https://mirrors.aliyun.com/debian-security";
  const bases = baseImagePlan({ dockerfile: read("Dockerfile"), manifest, lock: JSON.parse(read("package-lock.json")), normalizer: read("scripts/dependency-manifest.mjs"), monitor: treeContents(join(projectRoot, "monitor")), monitorScript: read("scripts/build-viron-monitor.sh"), architecture, registry, apt, aptSecurity });
  const run = (args, capture = false) => {
    const result = execute("docker", args, { cwd: projectRoot, env: { ...env, BUILDX_NO_DEFAULT_ATTESTATIONS: "1" }, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
    if (result.error || result.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} 失败：${result.error?.message ?? result.stderr ?? result.status}`);
    return result.stdout;
  };
  const builder = run(["buildx", "inspect", "--bootstrap"], true);
  if (!/^Driver:\s+docker\s*$/m.test(builder)) throw new Error("本地 Base 镜像需要 docker 驱动；请先运行 docker buildx use default（或选择当前 Docker context 的 docker 驱动 builder）。");
  const localImage = (tag, imageArchitecture = architecture) => {
    const result = execute("docker", ["image", "inspect", "--platform", `linux/${imageArchitecture}`, tag], { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) return false;
    try { return imageMatchesPlatform(JSON.parse(result.stdout)[0], imageArchitecture); } catch { return false; }
  };
  const baseArguments = [];
  const build = (target, tag, isBase, imageArchitecture = architecture) => {
    const started = performance.now();
    const args = ["buildx", "build", "--platform", `linux/${imageArchitecture}`, "--target", target, "--tag", tag, "--load", "--progress=plain", "--provenance=false", "--sbom=false", "--pull=false",
      "--build-arg", `APT_MIRROR=${apt}`, "--build-arg", `APT_SECURITY_MIRROR=${aptSecurity}`,
      "--build-context", `golang:1.26-bookworm=docker-image://${registry}/library/golang:1.26-bookworm`,
      "--build-context", `node:22-bookworm-slim=docker-image://${registry}/library/node:22-bookworm-slim`, ...baseArguments];
    if (refresh && isBase) {
      args.push("--no-cache");
      // Only upstream roots are pulled; derived Bases reference local tags.
      if (!["production-dependencies", "full-runtime"].includes(target)) args.push("--pull");
    }
    // Read old caches once during migration; normal builds keep immutable local
    // Base images instead of re-exporting gigabytes of mode=max cache every time.
    if (isBase && !refresh) {
      const cacheRoot = resolve(projectRoot, env.VIRON_DOCKER_CACHE_DIR || ".tmp/docker-build-cache");
      for (const previous of ["full", "lite", "script-runner"]) {
        const cache = join(cacheRoot, "release", architecture, previous);
        if (existsSync(join(cache, "index.json"))) args.push("--cache-from", `type=local,src=${cache}`);
      }
    }
    run([...args, projectRoot]);
    if (!localImage(tag, imageArchitecture)) throw new Error(`镜像架构校验失败：${tag}`);
    process.stdout.write(`[耗时] ${target}: ${((performance.now() - started) / 1000).toFixed(1)}s\n`);
  };
  for (const base of bases) {
    if (!refresh && localImage(base.image, base.architecture)) process.stdout.write(`[Base 命中] ${base.target}: ${base.image}\n`);
    else {
      process.stdout.write(`[Base ${refresh ? "刷新" : "创建"}] ${base.target}: ${base.image}\n`);
      build(base.target, base.image, true, base.architecture);
    }
    baseArguments.push("--build-arg", `${base.argument}=${base.image}`);
  }
  if (baseOnly) return;
  for (const [target, tag] of [["full", "viron-server-full"], ["lite", "viron-server-lite"], ["script-runner", "viron-script-runner"]]) {
    build(target, `${tag}:${manifest.version}`, false);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
      process.stdout.write("Usage: node scripts/package-server.mjs [--arch=amd64|arm64] [--base-only] [--refresh-docker-cache]\n默认复用本地 Base，仅构建服务镜像；--base-only 预热基础镜像。\n");
    } else {
      for (const arg of args) if (!/^--arch=(amd64|arm64)$/.test(arg) && !["--base-only", "--refresh-docker-cache"].includes(arg)) throw new Error(`未知参数：${arg}`);
      packageServer({ architecture: args.find((arg) => arg.startsWith("--arch="))?.slice(7) ?? (process.arch === "arm64" ? "arm64" : "amd64"), refresh: args.includes("--refresh-docker-cache"), baseOnly: args.includes("--base-only") });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
