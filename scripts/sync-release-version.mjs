import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const versionedFiles = [
  "docker-compose.full.yml",
  "docker-compose.lite.yml",
  "README.md",
  "README.zh-CN.md",
  "docs/USER-GUIDE.md",
  "release/README.md",
];

function assertReleaseVersion(version) {
  if (!versionPattern.test(version)) {
    throw new Error("版本号必须是可用于 Docker 标签的 SemVer，例如 0.1.5 或 0.2.0-rc.1");
  }
}

async function synchronizeReleaseVersion(targetVersion) {
  assertReleaseVersion(targetVersion);
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const currentVersion = packageJson.version;
  assertReleaseVersion(currentVersion);

  if (currentVersion === targetVersion) {
    process.stdout.write(`发布版本保持 ${currentVersion}\n`);
    return;
  }

  const updates = [];
  for (const relativePath of versionedFiles) {
    const path = join(root, relativePath);
    const content = await readFile(path, "utf8");
    if (!content.includes(currentVersion)) {
      throw new Error(`${relativePath} 未包含当前版本 ${currentVersion}，请先修正文档或配置中的版本一致性`);
    }
    updates.push({ path, relativePath, content: content.replaceAll(currentVersion, targetVersion) });
  }

  execFileSync("npm", ["version", targetVersion, "--no-git-tag-version", "--ignore-scripts"], {
    cwd: root,
    stdio: "inherit",
  });
  for (const update of updates) await writeFile(update.path, update.content, "utf8");

  const updatedPackageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (updatedPackageJson.version !== targetVersion) throw new Error("package.json 版本同步失败");
  process.stdout.write(`发布版本已从 ${currentVersion} 更新为 ${targetVersion}\n`);
  process.stdout.write(`已同步：package.json、package-lock.json、${versionedFiles.join("、")}\n`);
}

const targetVersion = process.argv[2];
if (!targetVersion || process.argv.length !== 3) {
  process.stderr.write("Usage: node scripts/sync-release-version.mjs <version>\n");
  process.exit(1);
}

await synchronizeReleaseVersion(targetVersion);
