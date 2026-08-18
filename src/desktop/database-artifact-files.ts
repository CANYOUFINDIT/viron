import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

function artifactStem(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKC")
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replaceAll(/^[._]+|[._]+$/g, "")
    .trim();
  return normalized || fallback;
}

export function databaseArtifactFilename(name: string, extension: string, fallback: string): string {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const currentExtension = extname(name);
  const stem = artifactStem(currentExtension ? name.slice(0, -currentExtension.length) : name, fallback);
  return `${stem}${normalizedExtension}`;
}

export class DatabaseArtifactFileRuntime {
  constructor(private readonly root: string) {}

  async queryFile(id: string, name: string, sql: string): Promise<string> {
    const directory = join(this.root, "database-artifacts", "queries");
    await mkdir(directory, { recursive: true });
    const filename = `${artifactStem(id, "query")}-${databaseArtifactFilename(name, ".sql", "query")}`;
    const path = join(directory, filename);
    await writeFile(path, sql, "utf8");
    return path;
  }

  async backupFile(id: string, filename: string, data: Uint8Array): Promise<string> {
    const directory = join(this.root, "database-artifacts", "backups");
    await mkdir(directory, { recursive: true });
    const safeName = databaseArtifactFilename(basename(filename), extname(filename) || ".sql", "backup");
    const path = join(directory, `${artifactStem(id, "backup")}-${safeName}`);
    await writeFile(path, data);
    return path;
  }
}
