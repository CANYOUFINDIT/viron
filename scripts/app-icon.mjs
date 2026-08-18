import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appIconSize = 1024;

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "pipe" });
}

export async function createAppIconPng(root) {
  if (process.platform !== "darwin") throw new Error("Viron App 图标只能在 macOS 构建机上从 SVG 生成");
  const directory = await mkdtemp(join(tmpdir(), "viron-app-icon-"));
  const source = join(root, "design", "logo", "viron-logo.svg");
  const raster = join(directory, "viron-logo.png");
  const icon = join(directory, "viron-app-icon.png");
  try {
    run("sips", [
      "-s", "format", "png",
      "--resampleWidth", String(appIconSize),
      source,
      "--out", raster,
    ]);
    run("sips", [
      "--padToHeightWidth", String(appIconSize), String(appIconSize),
      raster,
      "--out", icon,
    ]);
    const properties = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", icon]);
    if (!properties.includes(`pixelWidth: ${appIconSize}`)
      || !properties.includes(`pixelHeight: ${appIconSize}`)
      || !properties.includes("hasAlpha: yes")) {
      throw new Error(`Viron App 图标生成结果无效：\n${properties}`);
    }
    return { directory, icon, source };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
