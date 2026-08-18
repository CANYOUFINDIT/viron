import { describe, expect, it, vi } from "vitest";
import { listAgentModels } from "../src/desktop/agent-models.js";

const scope = { vironEndpoint: "https://viron.example.com", vironUserId: "user-1" };

function settingsStore(storedApiKey = "") {
  return { apiKeyFor: vi.fn(() => storedApiKey) } as never;
}

describe("AI Agent model listing", () => {
  it("uses the OpenAI models endpoint and bearer authentication", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "gpt-z" }, { id: "gpt-a" }, { id: "gpt-a" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await listAgentModels(settingsStore(), scope, {
      endpoint: "https://api.example.com/v1/",
      protocol: "openai",
      apiKey: "openai-key",
    }, request as typeof fetch);

    expect(result.models).toEqual(["gpt-a", "gpt-z"]);
    expect(request).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer openai-key" },
    }));
  });

  it("uses the versioned Anthropic endpoint and headers", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-sonnet" }] }), { status: 200 }));

    const result = await listAgentModels(settingsStore(), scope, {
      endpoint: "https://api.anthropic.com",
      protocol: "anthropic",
      apiKey: "anthropic-key",
    }, request as typeof fetch);

    expect(result.models).toEqual(["claude-sonnet"]);
    expect(request).toHaveBeenCalledWith("https://api.anthropic.com/v1/models", expect.objectContaining({
      headers: { "x-api-key": "anthropic-key", "anthropic-version": "2023-06-01" },
    }));
  });

  it("reuses the encrypted stored key when the settings form leaves API Key empty", async () => {
    const store = settingsStore("stored-key");
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await listAgentModels(store, scope, {
      endpoint: "https://api.example.com/v1",
      protocol: "openai",
    }, request as typeof fetch);

    expect(store.apiKeyFor).toHaveBeenCalledWith(scope, "https://api.example.com/v1", "openai");
    expect(request).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer stored-key" },
    }));
  });
});
