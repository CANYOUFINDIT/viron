import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ipcMain, type Session, type WebContents, type WebFrameMain } from "electron";

type Port = { partition: Session; extensionId: string; tab: WebContents; frame: WebFrameMain; send: (value: unknown) => void; cleanup: () => void };
const ports = new Map<string, Port>();
const pending = new Map<string, { frame: WebFrameMain; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const sessions = new WeakSet<Session>();
let nextWorldId = 10000;
const worlds = new Map<string, number>();
let initialized = false;

export function registerExtensionContentBridge(partition: Session, sendMessage: (partition: Session, id: string, message: unknown) => Promise<unknown>): void {
  if (!sessions.has(partition)) {
    sessions.add(partition);
    partition.registerPreloadScript({ type: "frame", filePath: fileURLToPath(new URL("./web-extension-content-preload.cjs", import.meta.url)) });
  }
  if (initialized) return;
  initialized = true;
  ipcMain.on("viron:extension-script-result", (event, requestId: string, value: unknown, error?: string) => {
    const request = pending.get(requestId);
    if (!request || event.senderFrame !== request.frame) return;
    pending.delete(requestId);
    if (error) request.reject(new Error(error)); else request.resolve(value);
  });
  ipcMain.on("viron:extension-content-port", (event, portId: string, message: unknown, disconnect: boolean) => {
    const port = ports.get(portId);
    if (!port || event.sender !== port.tab || event.senderFrame !== port.frame) return;
    port.send({ portId, message, disconnect });
    if (disconnect) { ports.delete(portId); port.cleanup(); }
  });
  ipcMain.handle("viron:extension-content-message", async (event, extensionId: string, message: unknown) => {
    // Only frames where a user-authorized script was injected can use this relay.
    if (!event.senderFrame || !injected.get(event.senderFrame)?.has(extensionId)) throw new Error("No extension script in this frame");
    return sendMessage(event.sender.session, extensionId, { __vironContentMessage: true, message, sender: {
      id: extensionId, url: event.senderFrame.url, frameId: event.senderFrame === event.sender.mainFrame ? 0 : event.senderFrame.routingId,
      tab: { id: event.sender.id, url: event.sender.getURL(), title: event.sender.getTitle() },
    } });
  });
}

const injected = new WeakMap<WebFrameMain, Set<string>>();
export function hasInjectedExtension(tab: WebContents, extensionId: string): boolean {
  return Boolean(injected.get(tab.mainFrame)?.has(extensionId));
}

export async function executeGrantedScript(tab: WebContents, extensionId: string, input: Record<string, any>, isGranted: () => boolean): Promise<unknown[]> {
  const extension = tab.session.extensions.getExtension(extensionId);
  if (!extension) throw new Error("Extension is no longer loaded");
  const pageOrigin = new URL(tab.getURL()).origin;
  const files = input.files as unknown;
  let code: string;
  if (Array.isArray(files) && files.length && files.length <= 32) {
    const root = await realpath(extension.path);
    const sources: string[] = [];
    for (const file of files) {
      if (typeof file !== "string") throw new Error("Invalid script path");
      const path = await realpath(resolve(root, file));
      if (!path.startsWith(root + sep)) throw new Error("Script must belong to this extension");
      sources.push(await readFile(path, "utf8"));
    }
    code = sources.join("\n;\n");
  } else if (typeof input.functionSource === "string" && input.functionSource.length <= 1_000_000) {
    code = `(${input.functionSource})(...${JSON.stringify(input.args ?? [])})`;
  } else throw new Error("A script function or file is required");
  if (!isGranted() || new URL(tab.getURL()).origin !== pageOrigin) throw new Error("activeTab permission expired during navigation");
  let worldId = worlds.get(extensionId);
  if (!worldId) { worldId = nextWorldId++; worlds.set(extensionId, worldId); }
  const target = input.target ?? {};
  if (target.allFrames && target.frameIds) throw new Error("Cannot specify both allFrames and frameIds");
  const origin = new URL(tab.getURL()).origin;
  const selected = target.allFrames ? tab.mainFrame.framesInSubtree : target.frameIds ? tab.mainFrame.framesInSubtree.filter((frame) => target.frameIds.includes(frame === tab.mainFrame ? 0 : frame.routingId)) : [tab.mainFrame];
  return Promise.all(selected.filter((frame: WebFrameMain) => {
    // activeTab grants the top-level origin, not unrelated cross-origin frames.
    try { return new URL(frame.url).origin === origin; } catch { return false; }
  }).map(async (frame: WebFrameMain) => {
    const requestId = randomUUID();
    let ids = injected.get(frame);
    if (!ids) { ids = new Set(); injected.set(frame, ids); }
    ids.add(extensionId);
    const result = await new Promise<unknown>((resolveResult, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Extension script timed out")); }, 30_000);
      pending.set(requestId, { frame, resolve: (value) => { clearTimeout(timer); resolveResult(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      frame.send("viron:extension-script", { requestId, extensionId, worldId, code, mainWorld: input.world === "MAIN" });
    });
    return { frameId: frame === tab.mainFrame ? 0 : frame.routingId, result };
  }));
}

export function connectGrantedPort(partition: Session, extensionId: string, tab: WebContents, options: Record<string, any>, send: (event: unknown) => void): string {
  const frame = options.frameId ? tab.mainFrame.framesInSubtree.find((frame) => frame.routingId === options.frameId) : tab.mainFrame;
  if (!frame || !injected.get(frame)?.has(extensionId)) throw new Error("No extension script in this frame");
  const portId = randomUUID();
  const cleanup = () => { tab.off("destroyed", disconnect); tab.off("did-start-navigation", navigated); };
  const port = { partition, extensionId, tab, frame, send, cleanup };
  ports.set(portId, port);
  const disconnect = () => {
    if (!ports.delete(portId)) return;
    cleanup();
    send({ portId, disconnect: true });
  };
  const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) { injected.delete(frame); disconnect(); }
  };
  tab.once("destroyed", disconnect);
  tab.on("did-start-navigation", navigated);
  frame.send("viron:extension-content-connect", { extensionId, portId, name: options.name ?? "" });
  return portId;
}

export function postGrantedPort(partition: Session, extensionId: string, portId: string, message: unknown, disconnect: boolean): void {
  const port = ports.get(portId);
  if (!port || port.partition !== partition || port.extensionId !== extensionId) throw new Error("Extension port is disconnected");
  port.frame.send("viron:extension-content-port", { extensionId, portId, message, disconnect });
  if (disconnect) { ports.delete(portId); port.cleanup(); }
}
