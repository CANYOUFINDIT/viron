import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopAgentSettings,
  saveDesktopAgentSettings,
} from "../src/client/desktop.js";
import type { AgentSettingsPublic } from "../src/shared/agent.js";

describe("AI Agent client settings state", () => {
  afterEach(() => {
    desktopAgentSettings.value = null;
    vi.unstubAllGlobals();
  });

  it("publishes saved settings immediately to every Agent entry", async () => {
    const saved: AgentSettingsPublic = {
      configured: true,
      endpoint: "https://model.example.test/v1",
      protocol: "openai",
      model: "test-model",
      apiKeyStored: true,
      approvalMode: "risk-only",
      executionPresentation: "workbench",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    vi.stubGlobal("window", {
      vironDesktop: {
        saveAgentSettings: vi.fn().mockResolvedValue(saved),
      },
    });

    await expect(saveDesktopAgentSettings({
      endpoint: saved.endpoint,
      protocol: saved.protocol,
      model: saved.model,
      apiKey: "secret",
      approvalMode: saved.approvalMode,
      executionPresentation: saved.executionPresentation,
    })).resolves.toEqual(saved);
    expect(desktopAgentSettings.value).toEqual(saved);
  });
});
