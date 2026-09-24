import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { extractWebExtensionArchive } from "../src/desktop/web-extension-archive.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "viron-extension-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function zip(entries: Record<string, string>): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) archive.addBuffer(Buffer.from(content), name);
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolveZip, rejectZip) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.once("end", () => resolveZip(Buffer.concat(chunks)));
    archive.outputStream.once("error", rejectZip);
  });
  archive.end();
  return await output;
}

describe("Web extension archives", () => {
  it("extracts ZIP and CRX3 payloads for local installation", async () => {
    const directory = await fixture();
    const content = '{"manifest_version":3,"name":"Fixture","version":"1.0"}';
    const payload = await zip({ "fixture/manifest.json": content });
    const zipPath = join(directory, "extension.zip");
    await writeFile(zipPath, payload);
    await extractWebExtensionArchive(zipPath, join(directory, "zip-output"));
    expect(await readFile(join(directory, "zip-output", "fixture", "manifest.json"), "utf8")).toBe(content);

    const header = Buffer.alloc(12);
    header.write("Cr24", 0, "ascii");
    header.writeUInt32LE(3, 4);
    const crxPath = join(directory, "extension.crx");
    await writeFile(crxPath, Buffer.concat([header, payload]));
    await extractWebExtensionArchive(crxPath, join(directory, "crx-output"));
    expect(await readFile(join(directory, "crx-output", "fixture", "manifest.json"), "utf8")).toBe(content);
  });

  it("rejects archive paths outside the extraction directory", async () => {
    const directory = await fixture();
    const payload = await zip({ "safe.txt": "bad" });
    const malicious = Buffer.from(payload.toString("binary").replaceAll("safe.txt", "../x.txt"), "binary");
    const archivePath = join(directory, "unsafe.zip");
    await writeFile(archivePath, malicious);
    await expect(extractWebExtensionArchive(archivePath, join(directory, "output"))).rejects.toThrow();
  });
});
