import { describe, expect, it, vi } from "vitest";
import { faviconCandidates, loadWebFavicon } from "../src/server/web-favicon.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("Web entry favicons", () => {
  it("resolves declared icons regardless of link attribute order", () => {
    const html = `
      <link href="/touch.png" rel="apple-touch-icon">
      <link sizes="32x32" href="icons/app.png" rel="shortcut icon">
      <link rel="stylesheet" href="/app.css">
    `;
    expect(faviconCandidates(html, "https://console.example.com/nested/login")).toEqual([
      "https://console.example.com/nested/icons/app.png",
      "https://console.example.com/touch.png",
    ]);
  });

  it("loads a declared site icon as a safe data URL", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://console.example.com/login") {
        return new Response('<html><head><link rel="icon" href="/assets/site.png"></head></html>', {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://console.example.com/assets/site.png") {
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      return new Response(null, { status: 404 });
    });

    await expect(loadWebFavicon("https://console.example.com/login", fetcher)).resolves.toBe(
      `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to the conventional origin favicon and rejects non-images", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://console.example.com/store/model") {
        return new Response("<html><title>Model</title></html>", { headers: { "content-type": "text/html" } });
      }
      return new Response(png, { headers: { "content-type": "application/octet-stream" } });
    });

    expect(await loadWebFavicon("https://console.example.com/store/model", fetcher)).toBe(
      `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
    );
    expect(requested).toContain("https://console.example.com/favicon.ico");

    const invalidFetcher = vi.fn(async () => new Response("not an image", { headers: { "content-type": "text/plain" } }));
    await expect(loadWebFavicon("https://example.com", invalidFetcher)).resolves.toBeNull();
  });
});
