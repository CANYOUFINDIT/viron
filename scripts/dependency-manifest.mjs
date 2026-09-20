import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Release metadata must not invalidate the dependency Base image.
export function dependencyManifests(manifest, lock) {
  const normalizedManifest = { ...manifest, version: "0.0.0" };
  const normalizedLock = structuredClone(lock);
  normalizedLock.version = "0.0.0";
  if (normalizedLock.packages?.[""]) normalizedLock.packages[""].version = "0.0.0";
  return [normalizedManifest, normalizedLock];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, lock] = dependencyManifests(
    JSON.parse(readFileSync("package.json", "utf8")),
    JSON.parse(readFileSync("package-lock.json", "utf8")),
  );
  writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
}
