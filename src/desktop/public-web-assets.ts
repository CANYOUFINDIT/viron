import { createHash } from "node:crypto";
import { join } from "node:path";
import { app, session, type Session, type WebContents } from "electron";
import { PublicWebAssetCache } from "../shared/public-web-asset-cache.js";
import { webDocumentLoading } from "./web-document.js";

const installed = new WeakMap<Session, PublicWebAssetCache>();
const caches = new Map<string, PublicWebAssetCache>();
const configured = new WeakSet<WebContents>();
const listening = new WeakSet<WebContents>();

export function installDesktopPublicWebAssets(partition: Session, endpoint: string, userId: string): void {
  if (installed.has(partition)) return;
  const scope = createHash("sha256").update(`${endpoint}\0${userId}`).digest("hex");
  let cache = caches.get(scope);
  if (!cache) {
    const anonymous = session.fromPartition(`persist:viron-public-assets-${scope}`);
    cache = new PublicWebAssetCache(join(app.getPath("userData"), "public-web-assets", scope),
      (url, options) => anonymous.fetch(url instanceof URL ? url.href : url, { ...options, credentials: "omit", bypassCustomProtocolHandlers: true }));
    caches.set(scope, cache);
  }
  installed.set(partition, cache);
}

/** Intercept static resources only; Chromium still owns navigation, cookies and TLS. */
export async function configureDesktopPublicWebAssets(contents: WebContents): Promise<void> {
  webDocumentLoading(contents);
  const assets = installed.get(contents.session);
  if (!assets || configured.has(contents) || contents.isDevToolsOpened()) return;
  if (!listening.has(contents)) {
    listening.add(contents);
    contents.debugger.on("detach", () => configured.delete(contents));
    contents.on("devtools-closed", () => { void configureDesktopPublicWebAssets(contents).catch(() => undefined); });
    contents.debugger.on("message", (_event, method, event) => {
      if (method !== "Fetch.requestPaused") return;
      void (async () => {
        if (event.request.method === "GET") {
          const origin = Object.entries(event.request.headers).find(([name]) => name.toLowerCase() === "origin")?.[1];
          const response = await assets.get(event.request.url, typeof origin === "string" ? origin : "");
          if (response) {
            await contents.debugger.sendCommand("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200,
              responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
              body: Buffer.from(await response.arrayBuffer()).toString("base64"),
            }); return;
          }
        }
        await contents.debugger.sendCommand("Fetch.continueRequest", { requestId: event.requestId });
      })().catch(() => { void contents.debugger.sendCommand("Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined); });
    });
  }
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  await contents.debugger.sendCommand("Fetch.enable", { patterns: ["Script", "Stylesheet", "Font", "Image"].map((resourceType) => ({ resourceType, requestStage: "Request" })) });
  configured.add(contents);
}
