import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("macOS packaging", () => {
  it("selects the signing keychain through the user search list", () => {
    const source = readFileSync(new URL("../scripts/package-macos.mjs", import.meta.url), "utf8");
    const signFunction = source.match(/function sign\([\s\S]*?\n}\n/)?.[0] ?? "";
    expect(source).toContain('["list-keychains", "-d", "user", "-s", signing.keychain, ...originalKeychains]');
    expect(signFunction).not.toContain('"--keychain"');
  });

  it("selects the Chromium backend that never opens macOS Keychain", () => {
    const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
    const switchIndex = source.indexOf('app.commandLine.appendSwitch("use-mock-keychain")');
    expect(switchIndex).toBeGreaterThan(0);
    expect(switchIndex).toBeLessThan(source.indexOf("app.whenReady()"));
  });
});
