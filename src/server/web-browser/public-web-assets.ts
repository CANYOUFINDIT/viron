import type { CDPSession } from "playwright-core";
import type { PublicWebAssetCache } from "../../shared/public-web-asset-cache.js";

/** CDP Fetch keeps the native HTTP cache enabled, unlike Playwright page.route. */
export async function configureServerWebRequests(cdp: CDPSession, options: {
  assets?: PublicWebAssetCache; mainFrameId?: string; allowedOrigins?: Set<string>; denied?: () => void;
}): Promise<void> {
  cdp.on("Fetch.requestPaused", (event) => {
    void (async () => {
      if (event.resourceType === "Document" && event.frameId === options.mainFrameId && options.allowedOrigins) {
        const url = new URL(event.request.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !options.allowedOrigins.has(url.origin)) {
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
          options.denied?.(); return;
        }
      }
      if (options.assets && event.request.method === "GET" && event.resourceType !== "Document") {
        const origin = Object.entries(event.request.headers).find(([name]) => name.toLowerCase() === "origin")?.[1] ?? "";
        const response = await options.assets.get(event.request.url, origin);
        if (response) {
          await cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200,
            responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
            body: Buffer.from(await response.arrayBuffer()).toString("base64"),
          }); return;
        }
      }
      await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
    })().catch(() => {
      // Teardown invalidates paused requests. Live failures resume the native request.
      void cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined);
    });
  });
  await cdp.send("Fetch.enable", { patterns: [
    ...(options.allowedOrigins ? [{ resourceType: "Document" as const, requestStage: "Request" as const }] : []),
    ...(options.assets ? (["Script", "Stylesheet", "Font", "Image"] as const).map((resourceType) => ({ resourceType, requestStage: "Request" as const })) : []),
  ] });
}
