import { posix } from "node:path";
import { Readable, Writable } from "node:stream";
import type { FileEntryWithStats, Stats } from "ssh2";
import { describe, expect, it } from "vitest";
import { transferSftpEntry, type TransferSftp } from "../src/server/sftp/transfer-manager.js";

type MemoryEntry =
  | { type: "directory"; mode: number }
  | { type: "file"; mode: number; content: Buffer };

function missing(path: string): NodeJS.ErrnoException {
  const error = new Error(`No such file: ${path}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

class MemorySftp implements TransferSftp {
  private readonly entries = new Map<string, MemoryEntry>([["/", { type: "directory", mode: 0o755 }]]);

  directory(path: string, mode = 0o755): this {
    this.ensureParents(path);
    this.entries.set(posix.resolve("/", path), { type: "directory", mode });
    return this;
  }

  file(path: string, content: string, mode = 0o640): this {
    this.ensureParents(path);
    this.entries.set(posix.resolve("/", path), { type: "file", mode, content: Buffer.from(content) });
    return this;
  }

  text(path: string): string | undefined {
    const entry = this.entries.get(posix.resolve("/", path));
    return entry?.type === "file" ? entry.content.toString("utf8") : undefined;
  }

  has(path: string): boolean {
    return this.entries.has(posix.resolve("/", path));
  }

  lstat(path: string, callback: (error: Error | undefined, attributes: Stats) => void): void {
    const entry = this.entries.get(posix.resolve("/", path));
    queueMicrotask(() => entry ? callback(undefined, this.stats(entry)) : callback(missing(path), undefined as unknown as Stats));
  }

  readdir(path: string, callback: (error: Error | undefined, entries: FileEntryWithStats[]) => void): void {
    const normalized = posix.resolve("/", path);
    const directory = this.entries.get(normalized);
    if (!directory || directory.type !== "directory") {
      queueMicrotask(() => callback(missing(path), []));
      return;
    }
    const children: FileEntryWithStats[] = [];
    for (const [entryPath, entry] of this.entries) {
      if (entryPath === normalized || posix.dirname(entryPath) !== normalized) continue;
      children.push({ filename: posix.basename(entryPath), longname: posix.basename(entryPath), attrs: this.stats(entry) });
    }
    queueMicrotask(() => callback(undefined, children));
  }

  mkdir(path: string, callback: (error?: Error | null) => void): void {
    const normalized = posix.resolve("/", path);
    const parent = this.entries.get(posix.dirname(normalized));
    queueMicrotask(() => {
      if (!parent || parent.type !== "directory") callback(missing(posix.dirname(normalized)));
      else {
        this.entries.set(normalized, { type: "directory", mode: 0o755 });
        callback();
      }
    });
  }

  unlink(path: string, callback: (error?: Error | null) => void): void {
    const normalized = posix.resolve("/", path);
    queueMicrotask(() => this.entries.delete(normalized) ? callback() : callback(missing(path)));
  }

  rmdir(path: string, callback: (error?: Error | null) => void): void {
    const normalized = posix.resolve("/", path);
    queueMicrotask(() => {
      const hasChildren = [...this.entries.keys()].some((entryPath) => entryPath !== normalized && posix.dirname(entryPath) === normalized);
      if (hasChildren) callback(Object.assign(new Error(`Directory not empty: ${path}`), { code: "ENOTEMPTY" }));
      else if (this.entries.get(normalized)?.type !== "directory") callback(missing(path));
      else {
        this.entries.delete(normalized);
        callback();
      }
    });
  }

  chmod(path: string, mode: number | string, callback: (error?: Error | null) => void): void {
    const entry = this.entries.get(posix.resolve("/", path));
    queueMicrotask(() => {
      if (!entry) callback(missing(path));
      else {
        entry.mode = typeof mode === "number" ? mode : Number.parseInt(mode, 8);
        callback();
      }
    });
  }

  createReadStream(path: string): Readable {
    const entry = this.entries.get(posix.resolve("/", path));
    if (!entry || entry.type !== "file") return Readable.from(Promise.reject(missing(path)));
    return Readable.from([entry.content]);
  }

  createWriteStream(path: string, options?: { flags?: string; mode?: number }): Writable {
    const normalized = posix.resolve("/", path);
    const chunks: Buffer[] = [];
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        this.entries.set(normalized, { type: "file", mode: options?.mode ?? 0o640, content: Buffer.concat(chunks) });
        callback();
      },
    });
  }

  private ensureParents(path: string): void {
    const parent = posix.dirname(posix.resolve("/", path));
    if (parent === "/") return;
    this.ensureParents(parent);
    if (!this.entries.has(parent)) this.entries.set(parent, { type: "directory", mode: 0o755 });
  }

  private stats(entry: MemoryEntry): Stats {
    return {
      mode: entry.mode,
      uid: 0,
      gid: 0,
      size: entry.type === "file" ? entry.content.length : 0,
      atime: 0,
      mtime: 0,
      isDirectory: () => entry.type === "directory",
      isFile: () => entry.type === "file",
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as Stats;
  }
}

describe("SFTP host-to-host transfer", () => {
  it("recursively copies a directory and overwrites same-name files", async () => {
    const source = new MemorySftp()
      .file("/release/app.txt", "new-app")
      .file("/release/config/prod.ini", "port=443");
    const target = new MemorySftp()
      .file("/deploy/release/app.txt", "old-app");
    const snapshots: number[] = [];

    const result = await transferSftpEntry(source, target, "/release", "/deploy/release", "overwrite", (progress) => {
      snapshots.push(progress.transferredBytes);
    });

    expect(target.text("/deploy/release/app.txt")).toBe("new-app");
    expect(target.text("/deploy/release/config/prod.ini")).toBe("port=443");
    expect(result).toMatchObject({ totalFiles: 2, completedFiles: 2, skippedFiles: 0, transferredBytes: 15 });
    expect(snapshots.at(-1)).toBe(15);
  });

  it("merges directories while skipping only conflicting files", async () => {
    const source = new MemorySftp()
      .file("/release/keep.txt", "source")
      .file("/release/new.txt", "new");
    const target = new MemorySftp()
      .file("/deploy/release/keep.txt", "target");

    const result = await transferSftpEntry(source, target, "/release", "/deploy/release", "skip");

    expect(target.text("/deploy/release/keep.txt")).toBe("target");
    expect(target.text("/deploy/release/new.txt")).toBe("new");
    expect(target.has("/deploy/release")).toBe(true);
    expect(result).toMatchObject({ totalFiles: 2, completedFiles: 1, skippedFiles: 1, transferredBytes: 3 });
  });

  it("replaces a target directory with a source file when overwrite is selected", async () => {
    const source = new MemorySftp().file("/artifact", "binary");
    const target = new MemorySftp().file("/deploy/artifact/old.txt", "old");

    await transferSftpEntry(source, target, "/artifact", "/deploy/artifact", "overwrite");

    expect(target.text("/deploy/artifact")).toBe("binary");
    expect(target.has("/deploy/artifact/old.txt")).toBe(false);
  });
});
