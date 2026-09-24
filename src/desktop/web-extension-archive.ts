import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 10_000;

function zipPayload(data: Buffer): Buffer {
  if (data.subarray(0, 4).toString("ascii") !== "Cr24") return data;
  if (data.length < 12) throw new Error("CRX 文件不完整");
  const version = data.readUInt32LE(4);
  let offset: number;
  if (version === 2) {
    if (data.length < 16) throw new Error("CRX 文件不完整");
    offset = 16 + data.readUInt32LE(8) + data.readUInt32LE(12);
  } else if (version === 3) {
    offset = 12 + data.readUInt32LE(8);
  } else {
    throw new Error("不支持此 CRX 版本");
  }
  if (offset >= data.length || data.subarray(offset, offset + 2).toString("ascii") !== "PK") {
    throw new Error("CRX 文件中没有有效的扩展内容");
  }
  return data.subarray(offset);
}

export async function extractWebExtensionArchive(archivePath: string, target: string): Promise<void> {
  if ((await stat(archivePath)).size > MAX_ARCHIVE_BYTES) throw new Error("扩展压缩包不能超过 100 MB");
  const file = await readFile(archivePath);
  if (file.length > MAX_ARCHIVE_BYTES) throw new Error("扩展压缩包不能超过 100 MB");
  await new Promise<void>((resolveArchive, rejectArchive) => {
    yauzl.fromBuffer(zipPayload(file), { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return rejectArchive(openError ?? new Error("无法打开扩展压缩包"));
      let fileCount = 0;
      let totalBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        rejectArchive(error);
      };
      zip.on("entry", (entry) => {
        if (settled) return;
        const name: string = entry.fileName;
        const segments = name.split("/");
        if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")
          || segments.some((part) => part === ".." || part === "." || /^[A-Za-z]:$/.test(part))) {
          return fail(new Error("扩展压缩包包含不安全路径"));
        }
        const destination = resolve(target, ...segments);
        if (!destination.startsWith(resolve(target) + sep)) return fail(new Error("扩展压缩包路径越界"));
        const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
          return fail(new Error("扩展压缩包不能包含符号链接或特殊文件"));
        }
        fileCount += 1;
        totalBytes += entry.uncompressedSize;
        if (fileCount > MAX_FILES || totalBytes > MAX_ARCHIVE_BYTES) return fail(new Error("扩展压缩包内容超过安全上限"));
        if (name.endsWith("/")) {
          void mkdir(destination, { recursive: true, mode: 0o700 }).then(() => zip.readEntry(), fail);
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error("无法读取扩展文件"));
          void (async () => {
            await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
            await pipeline(stream, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
            zip.readEntry();
          })().catch(fail);
        });
      });
      zip.once("error", fail);
      zip.once("end", () => {
        if (!settled) { settled = true; resolveArchive(); }
      });
      zip.readEntry();
    });
  });
}
