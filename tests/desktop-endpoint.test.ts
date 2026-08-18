import { describe, expect, it, vi } from "vitest";
import { normalizeEndpoint, validateEndpoint } from "../src/desktop/endpoint";

const capabilities = {
  product: "viron",
  productVersion: "0.1.0",
  apiProtocol: { min: 1, max: 2 },
  clientAccess: { desktop: true, web: true },
  desktopLocal: { web: true, ssh: true, sftp: true, logs: true, database: true, redis: true, inspection: true },
  mcp: { server: { enabled: true, path: "/mcp", transport: "streamable-http" as const, authentication: "personal-api-key" as const } },
  serverForwarding: { enabled: true, web: true, ssh: true, sftp: true, logs: true, database: true, redis: true },
};

describe("macOS desktop Endpoint", () => {
  it("accepts HTTP and HTTPS absolute Origins", () => {
    expect(normalizeEndpoint(" https://viron.example.test:8443/ ")).toBe("https://viron.example.test:8443");
    expect(normalizeEndpoint("http://viron.example.test")).toBe("http://viron.example.test");
    expect(normalizeEndpoint("http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
    expect(normalizeEndpoint("http://192.168.1.2:8080")).toBe("http://192.168.1.2:8080");
    expect(() => normalizeEndpoint("https://user:secret@viron.example.test")).toThrow("不能包含用户名或密码");
    expect(() => normalizeEndpoint("https://viron.example.test/app")).toThrow("只能填写 Origin");
    expect(() => normalizeEndpoint("https://viron.example.test/?from=app")).toThrow("只能填写 Origin");
    expect(() => normalizeEndpoint("file:///tmp/viron")).toThrow("HTTP(S) Origin");
  });

  it("validates Viron identity and selects a compatible protocol", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(
      JSON.stringify(String(url).endsWith("/healthz") ? { status: "ok", ...capabilities } : capabilities),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    await expect(validateEndpoint("https://viron.example.test", { fetcher })).resolves.toMatchObject({
      endpoint: "https://viron.example.test",
      protocolVersion: 2,
      capabilities,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects non-Viron responses and protocol ranges without an intersection", async () => {
    const nonViron = vi.fn(async () => new Response(JSON.stringify({ status: "ok", product: "other" }), { status: 200 }));
    await expect(validateEndpoint("https://example.test", { fetcher: nonViron })).rejects.toThrow("不是可识别的 Viron");

    const incompatible = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).endsWith("/healthz")
        ? { status: "ok", product: "viron" }
        : { ...capabilities, apiProtocol: { min: 3, max: 3 } },
    ), { status: 200 }));
    await expect(validateEndpoint("https://example.test", { fetcher: incompatible })).rejects.toThrow("请升级 App 或中心服务");
  });
});
