import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error("macOS tests must not use Electron safeStorage"); },
    decryptString: () => { throw new Error("macOS tests must not use Electron safeStorage"); },
  },
}));

import { DesktopAgentSettingsStore, type AgentSettingsScope } from "../src/desktop/agent-settings.js";

const temporaryDirectories: string[] = [];
const scope: AgentSettingsScope = { vironEndpoint: "https://viron.example", vironUserId: "user-1" };

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "viron-agent-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("macOS Agent settings storage", () => {
  it("stores and resolves the API key without Electron safeStorage", async () => {
    const directory = await temporaryDirectory();
    const store = new DesktopAgentSettingsStore(directory, "darwin");
    const saved = store.save(scope, {
      endpoint: "https://models.example/v1",
      protocol: "openai",
      model: "model-1",
      apiKey: "secret-api-key",
      approvalMode: "risk-only",
      executionPresentation: "workbench",
    });

    expect(saved.apiKeyStored).toBe(true);
    expect(store.resolve(scope)).toMatchObject({ apiKey: "secret-api-key", approvalMode: "risk-only", executionPresentation: "workbench" });
    expect(readFileSync(join(directory, "ai-agent-settings.json"), "utf8")).not.toContain("secret-api-key");
  });

  it("treats legacy Keychain ciphertext as unavailable and drops it on the next save", async () => {
    const directory = await temporaryDirectory();
    const store = new DesktopAgentSettingsStore(directory, "darwin");
    store.save(scope, {
      endpoint: "https://models.example/v1",
      protocol: "openai",
      model: "model-1",
      apiKey: "secret-api-key",
      approvalMode: "always",
      executionPresentation: "conversation",
    });
    const path = join(directory, "ai-agent-settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8")) as { records: Record<string, { apiKeyCiphertext?: string }> };
    const record = Object.values(settings.records)[0];
    record.apiKeyCiphertext = "legacy-keychain-ciphertext";
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    expect(store.get(scope).apiKeyStored).toBe(false);
    expect(store.resolve(scope).apiKey).toBe("");
    store.save(scope, {
      endpoint: "https://models.example/v1",
      protocol: "openai",
      model: "model-1",
      apiKey: "",
      approvalMode: "always",
      executionPresentation: "conversation",
    });
    expect(readFileSync(path, "utf8")).not.toContain("legacy-keychain-ciphertext");
  });

  it("migrates legacy model-only records to the restrictive Agent defaults", async () => {
    const directory = await temporaryDirectory();
    const store = new DesktopAgentSettingsStore(directory, "darwin");
    store.save(scope, {
      endpoint: "https://models.example/v1",
      protocol: "openai",
      model: "model-1",
      apiKey: "secret-api-key",
      approvalMode: "never",
      executionPresentation: "workbench",
    });
    const path = join(directory, "ai-agent-settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8")) as { records: Record<string, Record<string, unknown>> };
    const record = Object.values(settings.records)[0];
    delete record.approvalMode;
    delete record.executionPresentation;
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    expect(store.get(scope)).toMatchObject({ approvalMode: "always", executionPresentation: "conversation" });
    expect(store.resolve(scope)).toMatchObject({ approvalMode: "always", executionPresentation: "conversation" });
  });
});
