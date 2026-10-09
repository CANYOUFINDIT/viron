import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicWebAssetCache, publicWebAssetUrl } from "../src/shared/public-web-asset-cache.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() {
  mkdirSync("private/browser-tests", { recursive: true });
  const path = mkdtempSync(join(process.cwd(), "private/browser-tests/public-cache-")); directories.push(path); return path;
}
const url = "https://console.example.test/assets/app-AbCd1234.js";
const headers = { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" };

describe("public Web asset cache", () => {
  it("shares public bytes across accounts and process cache instances without passing account secrets", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      expect(options?.credentials).toBe("omit"); expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).has("cookie")).toBe(false);
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      return new Response("public bundle", { headers });
    });
    const root = directory();
    const first = new PublicWebAssetCache(root, fetcher);
    const concurrent = await Promise.all([first.get(url), first.get(url)]);
    expect(await concurrent[0]!.text()).toBe("public bundle");
    expect(await concurrent[1]!.text()).toBe("public bundle");
    expect(await (await new PublicWebAssetCache(root, fetcher).get(url))!.text()).toBe("public bundle");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("excludes documents, API responses, credentials in URLs and private cache policies", async () => {
    for (const path of ["/login", "/api/menu.json", "/assets/app-AbCd1234.js?token=secret", "/config.js"]) {
      expect(publicWebAssetUrl(new URL(path, url).href)).toBe(false);
    }
    for (const changes of [{ "Cache-Control": "private, max-age=3600" }, { "Cache-Control": "no-store" },
      { "Cache-Control": "no-cache" }, { "Set-Cookie": "account=private" }, { Vary: "Cookie" },
      { "Content-Type": "text/html" }]) {
      const fetcher = vi.fn(async () => new Response("private", { headers: { ...headers, ...changes } }));
      const cache = new PublicWebAssetCache(directory(), fetcher);
      expect(await cache.get(url)).toBeNull(); expect(await cache.get(url)).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it("expires cached bytes and honors origin variation", async () => {
    let now = 10_000;
    const fetcher = vi.fn(async () => new Response("bundle", { headers }));
    const cache = new PublicWebAssetCache(directory(), fetcher, () => now);
    await cache.get(url, "https://first.example.test");
    await cache.get(url, "https://second.example.test");
    await cache.get(url, "https://first.example.test");
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 3_600_001; await cache.get(url, "https://first.example.test");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("uses Last-Modified freshness only for versioned bundles, and removes decoded transfer headers", async () => {
    const now = Date.parse("2026-09-25T00:00:00Z");
    const fetcher = vi.fn(async () => new Response("decoded", { headers: { "Content-Type": "text/javascript",
      "Last-Modified": "Thu, 24 Sep 2026 00:00:00 GMT", "Content-Encoding": "gzip", "Content-Length": "12" } }));
    const cache = new PublicWebAssetCache(directory(), fetcher, () => now);
    const response = await cache.get(url);
    expect(response!.headers.has("content-encoding")).toBe(false);
    expect(response!.headers.get("content-length")).toBe("7");
    await cache.get(url); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await cache.get("https://console.example.test/static/config.js")).toBeNull();
  });
});
