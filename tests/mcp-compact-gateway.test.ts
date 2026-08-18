import { describe, expect, it, vi } from "vitest";
import { createVironMcpCompactGateway, VIRON_MCP_TOOL_NAMES } from "../src/shared/mcp-tools.js";

describe("Viron MCP compact gateway", () => {
  it("captures the compact tool catalog and invokes the original backend callbacks", async () => {
    const invoke = vi.fn(async (toolName: string, arguments_: Record<string, unknown>) => ({
      status: 200,
      headers: {},
      data: { toolName, arguments_ },
    }));
    const gateway = createVironMcpCompactGateway({ invoke });

    expect(gateway.tools.map((tool) => tool.name)).toEqual(VIRON_MCP_TOOL_NAMES);
    expect(gateway.tools.every((tool) => tool.title && tool.description)).toBe(true);
    const result = await gateway.invoke("viron_context", { workspace: "personal" });
    expect(invoke).toHaveBeenCalledWith("viron_context_get", { workspace: "personal" });
    expect(result).toMatchObject({
      structuredContent: {
        result: {
          status: 200,
          data: { toolName: "viron_context_get", arguments_: { workspace: "personal" } },
        },
      },
    });
  });
});
