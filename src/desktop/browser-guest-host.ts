import { randomUUID } from "node:crypto";
import { ipcMain, webContents, type Rectangle, type Session, type WebContents, type WebPreferences } from "electron";
import { browserGuestBindingAgent, browserGuestInitialUrl, type BrowserGuestRequest, type BrowserHostMessage } from "../shared/browser-host.js";

export interface BrowserPageHost {
  readonly kind: "guest" | "window";
  readonly webContents: WebContents;
  setBounds(bounds: Rectangle): void;
  getBounds(): Rectangle;
  setVisible(visible: boolean): void;
  focus(): void;
  dispose(): void;
}

interface PendingGuest {
  request: BrowserGuestRequest;
  owner: WebContents;
  session: Session;
  preferences: WebPreferences;
  attaching: boolean;
  resolve: (contents: WebContents) => void;
  reject: (error: Error) => void;
}

const pending = new Map<string, PendingGuest>();
const approved = new Map<WebContents, WebContents>();
const live = new Map<string, { owner: WebContents; viewId: string; dispose: () => void }>();
let ipcRegistered = false;

function send(owner: WebContents, message: BrowserHostMessage): void {
  if (!owner.isDestroyed()) owner.send("viron:browser-host", message);
}

// Only the app's main renderer can create guests, and only for a pending
// main-process request. Guest-controlled webview attributes are never trusted.
export function configureBrowserGuestHost(owner: WebContents): void {
  owner.on("will-attach-webview", (event, preferences, params) => {
    const entry = [...pending.values()].find((candidate) => candidate.owner === owner
      && browserGuestBindingAgent(candidate.request.token) === params.useragent
      && browserGuestInitialUrl() === params.src);
    if (!entry || entry.attaching || params.partition !== entry.request.partition) {
      event.preventDefault();
      return;
    }
    entry.attaching = true;
    for (const key of Object.keys(preferences)) delete (preferences as Record<string, unknown>)[key];
    Object.assign(preferences, entry.preferences);
    delete params.preload;
    delete params.webpreferences;
    params.src = browserGuestInitialUrl();
    // Consume the binding marker before Chromium sees a real page request.
    params.useragent = owner.getUserAgent();
  });
  owner.on("did-attach-webview", (_event, contents) => {
    if (contents.hostWebContents !== owner) {
      contents.close();
      return;
    }
    approved.set(contents, owner);
    contents.once("destroyed", () => approved.delete(contents));
  });
  owner.once("destroyed", () => {
    for (const [token, entry] of pending) {
      if (entry.owner !== owner) continue;
      pending.delete(token);
      entry.reject(new Error("Browser host closed"));
    }
    for (const entry of [...live.values()]) if (entry.owner === owner) entry.dispose();
  });
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("viron:browser-host:attached", (event, token: unknown, contentsId: unknown) => {
    const entry = typeof token === "string" ? pending.get(token) : null;
    const contents = typeof contentsId === "number" ? webContents.fromId(contentsId) : null;
    if (!entry || !entry.attaching || !contents || event.sender !== entry.owner || approved.get(contents) !== entry.owner
      || contents.session !== entry.session || contents.isDestroyed() || contents.getType() !== "webview") {
      throw new Error("Invalid or expired browser guest binding");
    }
    approved.delete(contents);
    pending.delete(entry.request.token);
    entry.resolve(contents);
  });
}

export async function createBrowserGuest(
  owner: WebContents,
  session: Session,
  partition: string,
  viewId: string,
  pageId: string,
  bounds: Rectangle,
  preferences: WebPreferences,
): Promise<BrowserPageHost> {
  const token = randomUUID();
  const request: BrowserGuestRequest = { token, viewId, pageId, partition, width: bounds.width, height: bounds.height };
  let timer: NodeJS.Timeout | undefined;
  const contents = await new Promise<WebContents>((resolve, reject) => {
    pending.set(token, { request, owner, session, preferences, attaching: false, resolve, reject });
    timer = setTimeout(() => {
      const entry = pending.get(token);
      if (!entry) return;
      pending.delete(token);
      send(owner, { type: "destroy", token });
      reject(new Error("Browser guest did not attach"));
    }, 15_000);
    send(owner, { type: "create", request });
  }).finally(() => clearTimeout(timer));
  contents.navigationHistory.clear();
  let currentBounds = { ...bounds };
  let visible = false;
  let revision = 0;
  let disposed = false;
  const present = (focus = false) => {
    if (!disposed) send(owner, { type: "present", presentation: { token, revision: ++revision, bounds: currentBounds, visible, focus } });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    live.delete(token);
    send(owner, { type: "destroy", token });
    if (!contents.isDestroyed()) contents.close();
  };
  live.set(token, { owner, viewId, dispose });
  contents.once("destroyed", dispose);
  return {
    kind: "guest",
    webContents: contents,
    setBounds(next) { currentBounds = { ...next }; present(); },
    getBounds() { return { ...currentBounds }; },
    setVisible(next) { visible = next; present(); },
    focus() { present(true); },
    dispose,
  };
}

export function closeBrowserGuests(viewId: string): void {
  for (const [token, entry] of pending) {
    if (entry.request.viewId !== viewId) continue;
    pending.delete(token);
    send(entry.owner, { type: "destroy", token });
    entry.reject(new Error("Browser page closed before attachment"));
  }
  for (const entry of [...live.values()]) if (entry.viewId === viewId) entry.dispose();
}
