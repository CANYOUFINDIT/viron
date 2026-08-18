import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";

describe("Vite development proxy", () => {
  it("proxies MCP confirmation pages to the same API target as application requests", async () => {
    expect(typeof viteConfig).toBe("function");
    if (typeof viteConfig !== "function") throw new Error("Expected Vite config factory");

    const config = await viteConfig({
      command: "serve",
      mode: "development",
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.server?.proxy?.["/mcp"]).toBe(config.server?.proxy?.["/api"]);
  });
});
