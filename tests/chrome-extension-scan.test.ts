import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeUserDataRoot, findChromeExtensions } from "../src/desktop/chrome-extension-scan.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Chrome extension discovery", () => {
  it("finds the newest installed version in each profile and resolves localized names", async () => {
    const root = await mkdtemp(join(tmpdir(), "viron-chrome-extensions-"));
    temporaryRoots.push(root);
    const chromeId = "a".repeat(32);
    const oldVersion = join(root, "Default", "Extensions", chromeId, "1.2_0");
    const currentVersion = join(root, "Default", "Extensions", chromeId, "1.10_0");
    await mkdir(oldVersion, { recursive: true });
    await mkdir(join(currentVersion, "_locales", "en"), { recursive: true });
    await writeFile(join(oldVersion, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Old", version: "1.2" }));
    await writeFile(join(currentVersion, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "__MSG_title__", default_locale: "en", version: "1.10" }));
    await writeFile(join(currentVersion, "_locales", "en", "messages.json"), JSON.stringify({ title: { message: "Current extension" } }));
    await symlink(join(root, "Default"), join(root, "Profile 2"));

    const found = await findChromeExtensions(root);
    expect(found).toEqual([{ chromeId, name: "Current extension", version: "1.10", profile: "Default", path: currentVersion }]);
  });

  it("uses the stable Chrome profile locations", () => {
    expect(chromeUserDataRoot("darwin", "/home/test")).toBe("/home/test/Library/Application Support/Google/Chrome");
    expect(chromeUserDataRoot("linux", "/home/test")).toBe("/home/test/.config/google-chrome");
    expect(chromeUserDataRoot("win32", "/home/test", "C:/Users/test/AppData/Local")).toBe(join("C:/Users/test/AppData/Local", "Google", "Chrome", "User Data"));
  });
});
