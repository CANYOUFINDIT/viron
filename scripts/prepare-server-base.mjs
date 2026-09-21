import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { packageServer } from "./package-server.mjs";

const args = process.argv.slice(2);
async function exportBases(images, destination) {
  const output = resolve(import.meta.dirname, "..", destination);
  if (!output.endsWith(".tar.gz")) throw new Error("Base 导出文件必须以 .tar.gz 结尾");
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  const child = spawn("docker", ["save", ...new Set(images)], { stdio: ["ignore", "pipe", "inherit"] });
  const finished = new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`Base 导出失败：docker save ${code}`)));
  });
  try {
    await Promise.all([pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(temporary)), finished]);
    renameSync(temporary, output);
    process.stdout.write(`Base 镜像包：${output}\n使用 docker load -i 加载，包含运行依赖和构建工具，不含 Viron 业务源码。\n`);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(temporary, { force: true });
  }
}
try {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: bash scripts/package-base.sh [--arch=all|amd64|arm64] [--refresh-docker-cache] [--export=path.tar.gz]\n一次准备独立于业务源码和版本号的 Base；默认准备 AMD64 和 ARM64。\n");
  } else {
    for (const arg of args) {
      if (!/^--arch=(all|amd64|arm64)$/.test(arg) && arg !== "--refresh-docker-cache" && !arg.startsWith("--export=")) throw new Error(`未知参数：${arg}`);
    }
    const architecture = args.find((arg) => arg.startsWith("--arch="))?.slice(7) ?? "all";
    const preparedImages = new Set();
    const images = [];
    for (const target of architecture === "all" ? ["amd64", "arm64"] : [architecture]) {
      const bases = packageServer({ architecture: target, baseOnly: true, refresh: args.includes("--refresh-docker-cache"), preparedImages });
      images.push(...bases.map((base) => base.image));
    }
    const destination = args.find((arg) => arg.startsWith("--export="))?.slice("--export=".length);
    if (destination) await exportBases(images, destination);
    process.stdout.write("Base 已准备好。之后执行 package-release.sh 或 package-server.mjs，只编译和打包代码。\n");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
