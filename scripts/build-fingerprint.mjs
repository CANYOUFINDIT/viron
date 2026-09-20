import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function fingerprintFiles(root, paths) {
  const hash = createHash("sha256");
  const visit = (path) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) { hash.update(`missing:${path}\0`); return; }
    // readdir is avoided for files, and every path is included to detect renames.
    let entries;
    try { entries = readdirSync(absolute, { withFileTypes: true }); } catch (error) {
      if (error.code !== "ENOTDIR") throw error;
      hash.update(path).update("\0").update(readFileSync(absolute)).update("\0");
      return;
    }
    hash.update(`directory:${path}\0`);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) visit(join(path, entry.name));
  };
  for (const path of paths) visit(path);
  return hash.digest("hex");
}
