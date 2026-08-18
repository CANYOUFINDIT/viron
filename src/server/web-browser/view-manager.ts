import { randomBytes, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Dialog,
  type FileChooser,
  type Page,
} from "playwright-core";
import type { RawData, WebSocket } from "ws";
import { normalizeWebAddress } from "../../shared/web-address.js";
import { idAfterClose, reorderMap } from "../../shared/tab-order.js";
import {
  buildWebCredentialAutofillScript,
  WEB_CREDENTIAL_AUTOFILL_DELAYS_MS,
  type WebCredentialAutofillResult,
} from "../../shared/web-credential-autofill.js";
import type { AuthenticatedUser } from "../access-control.js";

interface ViewTicket {
  ownerId: string;
  credentialId: string;
  executionScope: string | null;
  initiallyVisible: boolean;
  expiresAt: number;
}

interface StartingWebView {
  promise: Promise<ManagedWebView>;
  cancelled: boolean;
  reason: string;
  runtimeId: string;
}

interface StoredCredential {
  id: string;
  web_entry_id: string;
  username: string;
  password_ciphertext: string;
  entry_name: string;
  entry_url: string;
  last_url: string | null;
}

interface ManagedPage {
  id: string;
  page: Page;
  title: string;
  url: string;
  pendingUrl: string;
}

type InitialPageMode = "entry" | "blank";

interface ManagedWebView {
  key: string;
  runtimeId: string;
  ownerId: string;
  executionScope: string | null;
  credentialId: string;
  entryId: string;
  entryName: string;
  entryUrl: string;
  entryOrigin: string;
  username: string;
  profileDir: string;
  context: BrowserContext;
  pages: Map<string, ManagedPage>;
  pageIds: WeakMap<Page, string>;
  activePageId: string;
  sockets: Set<WebSocket>;
  visibleSockets: Set<WebSocket>;
  viewport: { width: number; height: number };
  lastActivityAt: number;
  closed: boolean;
  screencast: CDPSession | null;
  screencastPageId: string;
  pendingFileChooser: FileChooser | null;
  pendingDialog: Dialog | null;
  autoFillSignatures: Map<string, string>;
  messageQueue: Promise<void>;
}

interface DownloadArtifact {
  id: string;
  ownerId: string;
  credentialId: string;
  executionScope: string | null;
  path: string;
  filename: string;
  createdAt: number;
}

export interface PublicWebAccountView {
  credentialId: string;
  entryId: string;
  entryName: string;
  entryUrl: string;
  username: string;
  url: string;
  title: string;
  activePageId: string;
  pages: Array<{ id: string; title: string; url: string; active: boolean }>;
  viewport: { width: number; height: number };
}

export interface WebSemanticSnapshot {
  view: PublicWebAccountView;
  text: string;
  textTruncated: boolean;
  interactive: Array<{
    index: number;
    tag: string;
    role: string;
    name: string;
    href: string;
    disabled: boolean;
  }>;
}

export interface WebSemanticActionInput {
  action: "click" | "fill" | "select" | "submit";
  elementIndex: number;
  value?: string;
  expectedName?: string;
}

export interface WebSemanticControlInput {
  action: "navigate" | "back" | "forward" | "reload";
  url?: string;
}

const TICKET_TTL_MS = 30_000;
const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1200;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function safeFilename(value: string): string {
  const cleaned = basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
  return cleaned || "download";
}

function supportedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function browserExecutable(configured?: string): string {
  const candidates = [
    configured,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium-browser" : undefined,
  ].filter((value): value is string => Boolean(value));
  const match = candidates.find((value) => existsSync(value));
  if (!match) {
    throw new Error("未找到可用的 Chrome/Chromium，请设置 WEB_BROWSER_EXECUTABLE");
  }
  return match;
}

export class WebAccountViewManager {
  private readonly views = new Map<string, ManagedWebView>();
  private readonly starting = new Map<string, StartingWebView>();
  private readonly pageRegistrations = new WeakMap<Page, Promise<void>>();
  private readonly tickets = new Map<string, ViewTicket>();
  private readonly downloads = new Map<string, DownloadArtifact>();
  private readonly profilesRoot: string;
  private readonly downloadsRoot: string;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly app: FastifyInstance) {
    this.profilesRoot = join(app.config.dataDir, "web-profiles");
    this.downloadsRoot = join(app.config.dataDir, "web-downloads");
    mkdirSync(this.profilesRoot, { recursive: true });
    mkdirSync(this.downloadsRoot, { recursive: true });
    this.cleanupTimer = setInterval(() => void this.cleanup(), 30_000);
    this.cleanupTimer.unref();
  }

  async create(
    user: AuthenticatedUser,
    credentialId: string,
    width: number,
    height: number,
    executionScope: string | null = null,
    initialPage: InitialPageMode = "entry",
    preload = false,
  ): Promise<{ view: PublicWebAccountView; ticket: string; frame: string }> {
    const ownerId = user.id;
    const opened = await this.getOrCreate(user, credentialId, {
      width: clamp(width, MIN_WIDTH, MAX_WIDTH),
      height: clamp(height, MIN_HEIGHT, MAX_HEIGHT),
    }, executionScope, initialPage, preload);
    const view = opened.view;
    if (initialPage === "blank" && !opened.created) await this.createBlankPage(view);
    view.lastActivityAt = Date.now();
    this.app.activeConnections.touch(view.runtimeId);
    return {
      view: this.publicView(view),
      ticket: this.issueTicket(ownerId, credentialId, executionScope, !preload),
      frame: preload ? "" : await this.captureInitialFrame(view),
    };
  }

  attach(ticket: string, socket: WebSocket): void {
    const ticketData = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!ticketData || ticketData.expiresAt < Date.now()) {
      socket.close(4001, "页面票据无效或已过期");
      return;
    }
    const view = this.views.get(this.key(ticketData.ownerId, ticketData.credentialId, ticketData.executionScope));
    if (!view || view.closed) {
      socket.close(4004, "账号页面不存在");
      return;
    }
    view.sockets.add(socket);
    if (ticketData.initiallyVisible) view.visibleSockets.add(socket);
    view.lastActivityAt = Date.now();
    this.app.activeConnections.touch(view.runtimeId);
    this.send(socket, { type: "ready", view: this.publicView(view) });
    if (ticketData.initiallyVisible) void this.startScreencast(view).catch((error) => this.reportError(view, error));
    socket.on("message", (raw: RawData) => {
      view.messageQueue = view.messageQueue
        .then(() => this.onMessage(view, socket, raw.toString()))
        .catch((error) => this.reportError(view, error));
    });
    const detach = () => {
      view.sockets.delete(socket);
      view.visibleSockets.delete(socket);
      view.lastActivityAt = Date.now();
      if (!view.visibleSockets.size) void this.stopScreencast(view);
    };
    socket.once("close", detach);
    socket.once("error", detach);
  }

  async reset(ownerId: string, credentialId: string, executionScope: string | null = null): Promise<void> {
    await this.closeView(this.views.get(this.key(ownerId, credentialId, executionScope)), "正在重新登录");
    rmSync(this.profilePath(ownerId, credentialId, executionScope), { recursive: true, force: true });
    rmSync(this.downloadPath(ownerId, credentialId, executionScope), { recursive: true, force: true });
    if (!executionScope) await this.app.db.prepare("DELETE FROM web_account_views WHERE owner_user_id = ? AND credential_id = ?").run(ownerId, credentialId);
  }

  async closeCredential(ownerId: string, credentialId: string, executionScope: string | null = null, reason = "账号页面已关闭"): Promise<boolean> {
    const key = this.key(ownerId, credentialId, executionScope);
    const starting = this.starting.get(key);
    if (starting) {
      starting.cancelled = true;
      starting.reason = reason;
      if (starting.runtimeId) this.app.activeConnections.release(starting.runtimeId);
    }
    const view = this.views.get(key);
    if (view && !view.closed) await this.closeView(view, reason);
    return Boolean(starting || view);
  }

  async purgeCredential(credentialId: string): Promise<void> {
    const active = [...this.views.values()].filter((view) => view.credentialId === credentialId);
    await Promise.all(active.map((view) => this.closeView(view, "账号已删除")));
    for (const owner of readdirSync(this.profilesRoot, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      const root = join(this.profilesRoot, owner.name);
      rmSync(join(root, credentialId), { recursive: true, force: true });
      for (const scope of readdirSync(root, { withFileTypes: true })) {
        if (scope.isDirectory() && scope.name.startsWith("desktop-")) rmSync(join(root, scope.name, credentialId), { recursive: true, force: true });
      }
    }
    for (const owner of readdirSync(this.downloadsRoot, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      const root = join(this.downloadsRoot, owner.name);
      rmSync(join(root, credentialId), { recursive: true, force: true });
      for (const scope of readdirSync(root, { withFileTypes: true })) {
        if (scope.isDirectory() && scope.name.startsWith("desktop-")) rmSync(join(root, scope.name, credentialId), { recursive: true, force: true });
      }
    }
    for (const [id, artifact] of this.downloads) {
      if (artifact.credentialId === credentialId) this.downloads.delete(id);
    }
  }

  async sleepCredential(credentialId: string, reason = "Web 入口已更新"): Promise<void> {
    const active = [...this.views.values()].filter((view) => view.credentialId === credentialId);
    await Promise.all(active.map((view) => this.closeView(view, reason)));
  }

  async setUpload(ownerId: string, credentialId: string, path: string, executionScope: string | null = null): Promise<void> {
    const view = this.views.get(this.key(ownerId, credentialId, executionScope));
    if (!view || view.closed || !view.pendingFileChooser) throw new Error("当前页面没有等待选择文件");
    const chooser = view.pendingFileChooser;
    view.pendingFileChooser = null;
    await chooser.setFiles(path);
    view.lastActivityAt = Date.now();
    this.app.activeConnections.touch(view.runtimeId);
  }

  getDownload(ownerId: string, id: string, executionScope: string | null = null): { stream: ReturnType<typeof createReadStream>; filename: string; size: number; cleanup: () => void } | null {
    const artifact = this.downloads.get(id);
    if (!artifact || artifact.ownerId !== ownerId || artifact.executionScope !== executionScope || !existsSync(artifact.path)) return null;
    const cleanup = () => {
      this.downloads.delete(id);
      try { unlinkSync(artifact.path); } catch { /* The browser or caller may already have removed it. */ }
    };
    return { stream: createReadStream(artifact.path), filename: artifact.filename, size: statSync(artifact.path).size, cleanup };
  }

  activeCount(ownerId: string, executionScope: string | null): number {
    return [...this.views.values()].filter((view) => view.ownerId === ownerId && view.executionScope === executionScope && !view.closed).length;
  }

  async snapshot(
    user: AuthenticatedUser,
    credentialId: string,
    width: number,
    height: number,
    maxTextChars: number,
    executionScope: string | null = null,
  ): Promise<WebSemanticSnapshot> {
    const opened = await this.getOrCreate(user, credentialId, {
      width: clamp(width, MIN_WIDTH, MAX_WIDTH),
      height: clamp(height, MIN_HEIGHT, MAX_HEIGHT),
    }, executionScope, "entry");
    const view = opened.view;
    const page = view.pages.get(view.activePageId)?.page;
    if (!page || page.isClosed()) throw new Error("Web 页面不存在或已经关闭");
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    const semantic = await page.evaluate(`(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
      };
      const nameFor = (element) => (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
      const interactive = [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link],[tabindex]")]
        .filter(visible)
        .slice(0, 200)
        .map((element, index) => ({
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || "",
          name: nameFor(element),
          href: element instanceof HTMLAnchorElement ? element.href : "",
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        }));
      return { text: (document.body?.innerText || "").replace(/\\u0000/g, ""), interactive };
    })()` ) as { text: string; interactive: WebSemanticSnapshot["interactive"] };
    const limit = clamp(maxTextChars, 1_000, 200_000);
    view.lastActivityAt = Date.now();
    this.app.activeConnections.touch(view.runtimeId);
    return {
      view: this.publicView(view),
      text: semantic.text.slice(0, limit),
      textTruncated: semantic.text.length > limit,
      interactive: semantic.interactive,
    };
  }

  async semanticAction(
    user: AuthenticatedUser,
    credentialId: string,
    input: WebSemanticActionInput,
    executionScope: string | null = null,
  ): Promise<{ view: PublicWebAccountView; action: WebSemanticActionInput["action"]; element: { index: number; tag: string; name: string }; url: string; title: string }> {
    const opened = await this.getOrCreate(user, credentialId, { width: 1280, height: 720 }, executionScope, "entry");
    const view = opened.view;
    const page = view.pages.get(view.activePageId)?.page;
    if (!page || page.isClosed()) throw new Error("Web 页面不存在或已经关闭");
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
    const result = await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(payload)}), (character) => character.charCodeAt(0));
      const input = JSON.parse(new TextDecoder().decode(bytes));
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
      };
      const nameFor = (element) => (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
      const elements = [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link],[tabindex]")].filter(visible).slice(0, 200);
      const element = elements[input.elementIndex];
      if (!element) throw new Error("交互元素序号已失效，请重新读取页面快照");
      const name = nameFor(element);
      if (input.expectedName && name !== input.expectedName) throw new Error("交互元素名称已变化，请重新读取页面快照");
      if (element.disabled || element.getAttribute("aria-disabled") === "true") throw new Error("交互元素当前不可用");
      const setValue = (target, value) => {
        const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(target, value); else target.value = value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (input.action === "fill") {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("目标元素不支持文本填写");
        if (element instanceof HTMLInputElement && ["password", "file", "hidden"].includes(element.type.toLowerCase())) throw new Error("MCP 不允许填写密码、文件或隐藏输入框");
        setValue(element, input.value || "");
      } else if (input.action === "select") {
        if (!(element instanceof HTMLSelectElement)) throw new Error("目标元素不是下拉选择框");
        if (![...element.options].some((option) => option.value === input.value)) throw new Error("下拉选项不存在");
        element.value = input.value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (input.action === "submit") {
        const form = element.closest("form");
        if (form?.requestSubmit) form.requestSubmit(element instanceof HTMLButtonElement || (element instanceof HTMLInputElement && ["submit", "image"].includes(element.type)) ? element : undefined);
        else element.click();
      } else {
        element.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { index: input.elementIndex, tag: element.tagName.toLowerCase(), name };
    })()` ) as { index: number; tag: string; name: string };
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    await this.syncPage(view, page);
    view.lastActivityAt = Date.now();
    this.app.activeConnections.touch(view.runtimeId);
    return {
      view: this.publicView(view),
      action: input.action,
      element: result,
      url: page.url(),
      title: await page.title(),
    };
  }

  async semanticControl(
    user: AuthenticatedUser,
    credentialId: string,
    input: WebSemanticControlInput,
    executionScope: string | null = null,
  ): Promise<{ view: PublicWebAccountView; action: WebSemanticControlInput["action"]; url: string; title: string }> {
    const opened = await this.getOrCreate(user, credentialId, { width: 1280, height: 720 }, executionScope, "entry");
    const view = opened.view;
    const page = view.pages.get(view.activePageId)?.page;
    if (!page || page.isClosed()) throw new Error("Web 页面不存在或已经关闭");
    if (input.action === "navigate") {
      if (!input.url || !supportedUrl(input.url)) throw new Error("页面地址只支持 HTTP 或 HTTPS URL");
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } else if (input.action === "back") {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    } else if (input.action === "forward") {
      await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    } else {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await this.syncPage(view, page);
    view.lastActivityAt = Date.now();
    this.app.activeConnections.touch(view.runtimeId);
    return { view: this.publicView(view), action: input.action, url: page.url(), title: await page.title() };
  }

  async closeAll(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.all([...this.views.values()].map((view) => this.closeView(view, "Viron 服务正在停止")));
  }

  async closeOwner(ownerId: string, reason = "用户访问已失效", executionScope?: string | null): Promise<void> {
    await Promise.all([...this.views.values()]
      .filter((view) => view.ownerId === ownerId && (executionScope === undefined || view.executionScope === executionScope))
      .map((view) => this.closeView(view, reason)));
    for (const [id, artifact] of this.downloads) {
      if (artifact.ownerId !== ownerId || (executionScope !== undefined && artifact.executionScope !== executionScope)) continue;
      try { unlinkSync(artifact.path); } catch { /* The artifact may already be gone. */ }
      this.downloads.delete(id);
    }
  }

  private async getOrCreate(
    user: AuthenticatedUser,
    credentialId: string,
    viewport: { width: number; height: number },
    executionScope: string | null,
    initialPage: InitialPageMode,
    preload = false,
  ): Promise<{ view: ManagedWebView; created: boolean }> {
    const ownerId = user.id;
    const key = this.key(ownerId, credentialId, executionScope);
    const pending = this.starting.get(key);
    if (pending) {
      if (pending.cancelled) {
        await pending.promise.catch(() => undefined);
        return this.getOrCreate(user, credentialId, viewport, executionScope, initialPage, preload);
      }
      const view = await pending.promise;
      await this.resize(view, viewport.width, viewport.height);
      return { view, created: false };
    }
    const existing = this.views.get(key);
    if (existing && !existing.closed) {
      await this.resize(existing, viewport.width, viewport.height);
      return { view: existing, created: false };
    }
    const starting: StartingWebView = {
      promise: Promise.resolve(null as unknown as ManagedWebView),
      cancelled: false,
      reason: "",
      runtimeId: "",
    };
    const launch = this.launch(user, credentialId, viewport, executionScope, initialPage, preload, starting)
      .finally(() => {
        if (this.starting.get(key) === starting) this.starting.delete(key);
      });
    starting.promise = launch;
    this.starting.set(key, starting);
    return { view: await launch, created: true };
  }

  private async launch(
    user: AuthenticatedUser,
    credentialId: string,
    viewport: { width: number; height: number },
    executionScope: string | null,
    initialPage: InitialPageMode,
    preload: boolean,
    starting: StartingWebView,
  ): Promise<ManagedWebView> {
    const ownerId = user.id;
    if ((this.app.config.webSessionExecutor ?? "server") !== "server") throw new Error("当前部署未启用服务端 Web 页面执行");
    await this.enforcePlatformLimit();
    const credential = await this.app.db.prepare(`
      SELECT c.id, c.web_entry_id, c.username, c.password_ciphertext,
        w.name AS entry_name, w.url AS entry_url, v.last_url
      FROM web_credentials c
      JOIN web_entries w ON w.id = c.web_entry_id
      LEFT JOIN web_account_views v ON v.credential_id = c.id AND v.owner_user_id = ?
      WHERE c.id = ?
    `).get(ownerId, credentialId) as StoredCredential | undefined;
    if (!credential) throw new Error("登录账号不存在");
    if (!supportedUrl(credential.entry_url)) throw new Error("Web 入口地址只支持 HTTP 或 HTTPS");

    const runtimeId = randomUUID();
    await this.app.activeConnections.reserve({ id: runtimeId, user, type: "web", resourceId: credentialId, executionScope });
    starting.runtimeId = runtimeId;
    if (starting.cancelled) {
      this.app.activeConnections.release(runtimeId);
      throw new Error(starting.reason || "页面预热已取消");
    }

    const profileDir = this.profilePath(ownerId, credentialId, executionScope);
    const downloadDir = this.downloadPath(ownerId, credentialId, executionScope);
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(downloadDir, { recursive: true });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
      executablePath: browserExecutable(this.app.config.webBrowserExecutable),
      headless: true,
      viewport,
      acceptDownloads: true,
      locale: "zh-CN",
      args: [
        "--disable-background-networking",
        "--disable-breakpad",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-features=Translate,MediaRouter",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-default-browser-check",
        "--no-first-run",
      ],
      });
    } catch (error) {
      this.app.activeConnections.release(runtimeId);
      throw error;
    }
    if (starting.cancelled) {
      await context.close().catch(() => undefined);
      this.app.activeConnections.release(runtimeId);
      throw new Error(starting.reason || "页面预热已取消");
    }
    context.setDefaultTimeout(15_000);
    const view: ManagedWebView = {
      key: this.key(ownerId, credentialId, executionScope),
      runtimeId,
      ownerId,
      executionScope,
      credentialId,
      entryId: credential.web_entry_id,
      entryName: credential.entry_name,
      entryUrl: credential.entry_url,
      entryOrigin: new URL(credential.entry_url).origin,
      username: credential.username,
      profileDir,
      context,
      pages: new Map(),
      pageIds: new WeakMap(),
      activePageId: "",
      sockets: new Set(),
      visibleSockets: new Set(),
      viewport,
      lastActivityAt: Date.now(),
      closed: false,
      screencast: null,
      screencastPageId: "",
      pendingFileChooser: null,
      pendingDialog: null,
      autoFillSignatures: new Map(),
      messageQueue: Promise.resolve(),
    };
    this.views.set(view.key, view);
    this.app.activeConnections.activate(runtimeId, (reason) => this.closeView(view, reason));
    context.on("page", (page) => void this.registerPage(view, page, true));
    context.on("close", () => {
      view.closed = true;
      if (this.views.get(view.key) === view) this.views.delete(view.key);
      this.app.activeConnections.release(view.runtimeId);
    });
    if (starting.cancelled) {
      await this.closeView(view, starting.reason || "页面预热已取消");
      throw new Error(starting.reason || "页面预热已取消");
    }

    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    await this.registerPage(view, page, true);
    const initialUrl = !executionScope && credential.last_url && supportedUrl(credential.last_url) ? credential.last_url : credential.entry_url;
    if (initialPage === "blank") {
      const item = view.pages.get(view.pageIds.get(page) ?? "");
      if (item) {
        item.pendingUrl = initialUrl;
        item.url = initialUrl;
        item.title = view.entryName || view.username;
      }
      await this.createBlankPage(view);
    } else if (page.url() === "about:blank") {
      const navigation = page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => {
        if (!view.closed) this.reportError(view, error);
      });
      if (!preload) await navigation;
    }
    if (initialPage === "entry" && !preload) {
      await this.syncPage(view, page);
      this.scheduleAutoFill(view, page);
    }
    return view;
  }

  private async createBlankPage(view: ManagedWebView): Promise<void> {
    const page = await view.context.newPage();
    await this.registerPage(view, page, true);
    const pageId = view.pageIds.get(page);
    if (pageId && view.activePageId !== pageId) await this.activatePage(view, pageId);
    await this.syncPage(view, page);
  }

  private registerPage(view: ManagedWebView, page: Page, activate: boolean): Promise<void> {
    const existing = this.pageRegistrations.get(page);
    if (existing) {
      if (!activate) return existing;
      return existing.then(async () => {
        const pageId = view.pageIds.get(page);
        if (pageId && view.activePageId !== pageId) await this.activatePage(view, pageId);
      });
    }
    const registration = this.registerNewPage(view, page, activate);
    this.pageRegistrations.set(page, registration);
    return registration;
  }

  private async registerNewPage(view: ManagedWebView, page: Page, activate: boolean): Promise<void> {
    const id = randomUUID();
    const item: ManagedPage = { id, page, title: "新页面", url: page.url(), pendingUrl: "" };
    view.pages.set(id, item);
    view.pageIds.set(page, id);
    page.on("domcontentloaded", () => {
      void this.syncPage(view, page);
      this.scheduleAutoFill(view, page);
    });
    page.on("load", () => {
      void this.syncPage(view, page);
      this.scheduleAutoFill(view, page);
    });
    page.on("request", () => {
      view.lastActivityAt = Date.now();
      this.app.activeConnections.touch(view.runtimeId);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.syncPage(view, page);
    });
    page.on("close", () => {
      void this.pageClosed(view, id).catch((error) => {
        if (!view.closed) this.reportError(view, error);
      });
    });
    page.on("crash", () => this.broadcast(view, { type: "error", message: "页面渲染进程已崩溃，请刷新后重试" }));
    page.on("filechooser", (chooser) => {
      view.pendingFileChooser = chooser;
      this.broadcast(view, { type: "fileChooser", multiple: chooser.isMultiple() });
    });
    page.on("dialog", (dialog) => {
      view.pendingDialog = dialog;
      this.broadcast(view, { type: "dialog", dialogType: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() });
    });
    page.on("download", (download) => void this.handleDownload(view, download));
    await this.syncPage(view, page);
    if (activate || !view.activePageId) await this.activatePage(view, id);
    else this.broadcastState(view);
  }

  private async captureInitialFrame(view: ManagedWebView): Promise<string> {
    const page = view.pages.get(view.activePageId)?.page;
    if (!page || page.isClosed()) return "";
    try {
      const frame = await page.screenshot({ type: "jpeg", quality: 72, timeout: 5_000 });
      return frame.toString("base64");
    } catch {
      return "";
    }
  }

  private async pageClosed(view: ManagedWebView, pageId: string): Promise<void> {
    const nextPageId = idAfterClose([...view.pages.keys()], view.activePageId, pageId);
    view.pages.delete(pageId);
    view.autoFillSignatures.delete(pageId);
    if (view.closed) return;
    if (!view.pages.size) {
      const page = await view.context.newPage().catch(() => null);
      if (!page || view.closed) return;
      await this.registerPage(view, page, true);
      await page.goto(view.entryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => this.reportError(view, error));
      return;
    }
    if (view.activePageId === pageId) {
      await this.activatePage(view, nextPageId ?? [...view.pages.keys()][0]!);
    } else {
      this.broadcastState(view);
    }
  }

  private async activatePage(view: ManagedWebView, pageId: string): Promise<void> {
    const item = view.pages.get(pageId);
    if (!item) return;
    view.activePageId = pageId;
    view.lastActivityAt = Date.now();
    this.app.activeConnections.touch(view.runtimeId);
    await item.page.bringToFront().catch(() => undefined);
    await item.page.setViewportSize(view.viewport).catch(() => undefined);
    const pendingUrl = item.pendingUrl;
    if (pendingUrl) {
      item.pendingUrl = "";
      await item.page.goto(pendingUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => this.reportError(view, error));
    }
    await this.stopScreencast(view);
    if (view.visibleSockets.size) await this.startScreencast(view);
    await this.syncPage(view, item.page);
    this.scheduleAutoFill(view, item.page);
    this.broadcastState(view);
  }

  private async startScreencast(view: ManagedWebView): Promise<void> {
    if (view.closed || !view.visibleSockets.size || view.screencast) return;
    const item = view.pages.get(view.activePageId);
    if (!item) return;
    const session = await view.context.newCDPSession(item.page);
    view.screencast = session;
    view.screencastPageId = item.id;
    session.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
      if (view.screencast !== session) return;
      this.app.activeConnections.recordTraffic(view.runtimeId, { receivedBytes: Math.floor(event.data.length * 0.75) });
      this.broadcastVisible(view, { type: "frame", data: event.data, pageId: item.id });
      void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    });
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 72,
      maxWidth: view.viewport.width,
      maxHeight: view.viewport.height,
      everyNthFrame: 1,
    });
    const initialFrame = await session.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 72,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (view.screencast === session) {
      this.app.activeConnections.recordTraffic(view.runtimeId, { receivedBytes: Math.floor(initialFrame.data.length * 0.75) });
      this.broadcastVisible(view, { type: "frame", data: initialFrame.data, pageId: item.id });
    }
  }

  private async stopScreencast(view: ManagedWebView): Promise<void> {
    const session = view.screencast;
    view.screencast = null;
    view.screencastPageId = "";
    if (!session) return;
    await session.send("Page.stopScreencast").catch(() => undefined);
    await session.detach().catch(() => undefined);
  }

  private async resize(view: ManagedWebView, width: number, height: number): Promise<void> {
    const viewport = { width: clamp(width, MIN_WIDTH, MAX_WIDTH), height: clamp(height, MIN_HEIGHT, MAX_HEIGHT) };
    if (view.viewport.width === viewport.width && view.viewport.height === viewport.height) return;
    view.viewport = viewport;
    const page = view.pages.get(view.activePageId)?.page;
    if (page) await page.setViewportSize(viewport).catch(() => undefined);
    await this.stopScreencast(view);
    if (view.visibleSockets.size) await this.startScreencast(view);
    this.broadcastState(view);
  }

  private async onMessage(view: ManagedWebView, socket: WebSocket, raw: string): Promise<void> {
    view.lastActivityAt = Date.now();
    this.app.activeConnections.recordTraffic(view.runtimeId, { sentBytes: Buffer.byteLength(raw) }, view.lastActivityAt);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.send(socket, { type: "error", message: "页面消息格式不正确" });
      return;
    }
    const page = view.pages.get(view.activePageId)?.page;
    if (!page) return;
    try {
      switch (message.type) {
        case "resize":
          await this.resize(view, Number(message.width), Number(message.height));
          break;
        case "visibility":
          await this.setSocketVisibility(view, socket, message.visible === true);
          break;
        case "mouse":
          await this.handleMouse(page, message);
          break;
        case "wheel":
          await page.mouse.wheel(Number(message.deltaX) || 0, Number(message.deltaY) || 0);
          break;
        case "key":
          await this.handleKey(page, message);
          break;
        case "paste":
          if (typeof message.text === "string") await page.keyboard.insertText(message.text.slice(0, 100_000));
          break;
        case "navigate":
          const url = typeof message.url === "string" ? normalizeWebAddress(message.url) : null;
          if (!url || !supportedUrl(url)) throw new Error("请输入有效的 HTTP 或 HTTPS 地址");
          view.pages.get(view.activePageId)!.pendingUrl = "";
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          break;
        case "back":
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
          break;
        case "forward":
          await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
          break;
        case "reload":
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
          break;
        case "newPage":
          await this.createBlankPage(view);
          break;
        case "activatePage":
          if (typeof message.pageId === "string") await this.activatePage(view, message.pageId);
          break;
        case "closePage":
          if (typeof message.pageId === "string" && view.pages.size > 1) await view.pages.get(message.pageId)?.page.close();
          break;
        case "reorderPages":
          const orderedPageIds = Array.isArray(message.orderedPageIds) && message.orderedPageIds.every((id) => typeof id === "string")
            ? message.orderedPageIds
            : [];
          const reordered = reorderMap(view.pages, orderedPageIds);
          if (!reordered) throw new Error("页面标签排序必须包含当前账号的全部页面");
          view.pages = reordered;
          this.broadcastState(view);
          break;
        case "refill":
          view.autoFillSignatures.delete(view.activePageId);
          await this.autoFill(view, page, true);
          break;
        case "dialog":
          await this.handleDialog(view, message);
          break;
        case "ping":
          this.send(socket, { type: "pong" });
          break;
      }
    } catch (error) {
      this.send(socket, { type: "error", message: error instanceof Error ? error.message : "页面操作失败" });
    }
  }

  private async handleMouse(page: Page, message: Record<string, unknown>): Promise<void> {
    const x = Number(message.x);
    const y = Number(message.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const button = message.button === "right" ? "right" : message.button === "middle" ? "middle" : "left";
    const clickCount = clamp(Number(message.clickCount) || 1, 1, 3);
    if (message.action === "move") await page.mouse.move(x, y);
    if (message.action === "down") {
      await page.mouse.move(x, y);
      await page.mouse.down({ button, clickCount });
    }
    if (message.action === "up") {
      await page.mouse.move(x, y);
      await page.mouse.up({ button, clickCount });
    }
  }

  private async setSocketVisibility(view: ManagedWebView, socket: WebSocket, visible: boolean): Promise<void> {
    if (visible) {
      view.visibleSockets.add(socket);
      view.lastActivityAt = Date.now();
      this.app.activeConnections.touch(view.runtimeId);
      await this.startScreencast(view);
      return;
    }
    view.visibleSockets.delete(socket);
    if (!view.visibleSockets.size) await this.stopScreencast(view);
  }

  private async handleKey(page: Page, message: Record<string, unknown>): Promise<void> {
    if (typeof message.key !== "string") return;
    const modifiers = [
      message.ctrl ? "Control" : "",
      message.alt ? "Alt" : "",
      message.shift ? "Shift" : "",
      message.meta ? "Meta" : "",
    ].filter(Boolean);
    if (!modifiers.length && typeof message.text === "string" && message.text) {
      await page.keyboard.insertText(message.text);
      return;
    }
    const key = message.key === " " ? "Space" : message.key;
    await page.keyboard.press([...modifiers, key].join("+"));
  }

  private async handleDialog(view: ManagedWebView, message: Record<string, unknown>): Promise<void> {
    const dialog = view.pendingDialog;
    view.pendingDialog = null;
    if (!dialog) return;
    if (message.action === "accept") await dialog.accept(typeof message.promptText === "string" ? message.promptText : undefined);
    else await dialog.dismiss();
  }

  private scheduleAutoFill(view: ManagedWebView, page: Page): void {
    for (const delay of WEB_CREDENTIAL_AUTOFILL_DELAYS_MS) {
      const timer = setTimeout(() => void this.autoFill(view, page, false), delay);
      timer.unref();
    }
  }

  private async autoFill(view: ManagedWebView, page: Page, force: boolean): Promise<void> {
    if (view.closed || page.isClosed()) return;
    let currentOrigin = "";
    try { currentOrigin = new URL(page.url()).origin; } catch { return; }
    if (currentOrigin !== view.entryOrigin) {
      if (force) this.broadcast(view, { type: "autofill", status: "skipped", message: "当前页面不在入口原始域名，未填充账号密码" });
      return;
    }
    const row = await this.app.db.prepare("SELECT username, password_ciphertext FROM web_credentials WHERE id = ?").get(view.credentialId) as { username: string; password_ciphertext: string } | undefined;
    if (!row) return;
    view.username = row.username;
    const password = this.app.secrets.decrypt(row.password_ciphertext);
    const pageId = view.pageIds.get(page);
    if (!pageId) return;
    const previousSignature = force ? "" : (view.autoFillSignatures.get(pageId) ?? "");
    let result: WebCredentialAutofillResult;
    try {
      result = await page.evaluate(buildWebCredentialAutofillScript({
        username: row.username,
        password,
        previousSignature,
        autoSubmit: true,
        messages: {
          duplicate: "登录表单未变化",
          ambiguousPasswords: "检测到多个密码框，未识别到唯一登录密码框",
          noReliableForm: "未识别到可靠的登录表单",
          filled: "已填写账号密码",
          filledAndSubmitted: "已填写并提交登录表单",
        },
      })) as WebCredentialAutofillResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/execution context was destroyed|navigation|cannot find context/i.test(message)) {
        result = { status: "filled", signature: "", message: "已提交登录表单" };
      } else {
        this.app.log.warn({ errorMessage: message, credentialId: view.credentialId }, "web login form evaluation failed");
        result = { status: "skipped", signature: "", message: "无法访问当前登录表单" };
      }
    }
    if (result.signature) view.autoFillSignatures.set(pageId, result.signature);
    if (force || result.status === "filled") this.broadcast(view, { type: "autofill", status: result.status, message: result.message });
  }

  private async syncPage(view: ManagedWebView, page: Page): Promise<void> {
    const pageId = view.pageIds.get(page);
    if (!pageId) return;
    const item = view.pages.get(pageId);
    if (!item) return;
    const pendingUrl = item.pendingUrl;
    item.url = pendingUrl || page.url();
    item.title = pendingUrl
      ? view.entryName || view.username
      : (await page.title().catch(() => "")) || (item.url === "about:blank" ? "新页面" : view.entryName || "新页面");
    if (!pendingUrl && !view.executionScope && view.activePageId === pageId && supportedUrl(item.url)) {
      await this.app.db.prepare(`
        INSERT INTO web_account_views (owner_user_id, credential_id, last_url, last_title, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner_user_id, credential_id) DO UPDATE SET
          last_url = excluded.last_url,
          last_title = excluded.last_title,
          updated_at = excluded.updated_at
      `).run(view.ownerId, view.credentialId, item.url, item.title, new Date().toISOString());
    }
    this.broadcastState(view);
  }

  private async handleDownload(view: ManagedWebView, download: import("playwright-core").Download): Promise<void> {
    const id = randomUUID();
    const filename = safeFilename(download.suggestedFilename());
    const directory = this.downloadPath(view.ownerId, view.credentialId, view.executionScope);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}-${filename}`);
    try {
      await download.saveAs(path);
      this.downloads.set(id, { id, ownerId: view.ownerId, credentialId: view.credentialId, executionScope: view.executionScope, path, filename, createdAt: Date.now() });
      this.broadcast(view, { type: "download", id, filename, url: `/api/v1/web-view-downloads/${id}` });
    } catch (error) {
      this.reportError(view, error);
    }
  }

  private publicView(view: ManagedWebView): PublicWebAccountView {
    const active = view.pages.get(view.activePageId);
    return {
      credentialId: view.credentialId,
      entryId: view.entryId,
      entryName: view.entryName,
      entryUrl: view.entryUrl,
      username: view.username,
      url: active?.url ?? view.entryUrl,
      title: active?.title ?? view.entryName,
      activePageId: view.activePageId,
      pages: [...view.pages.values()].map((item) => ({ id: item.id, title: item.title, url: item.url, active: item.id === view.activePageId })),
      viewport: view.viewport,
    };
  }

  private broadcastState(view: ManagedWebView): void {
    this.broadcast(view, { type: "state", view: this.publicView(view) });
  }

  private broadcast(view: ManagedWebView, message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const socket of view.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private broadcastVisible(view: ManagedWebView, message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const socket of view.visibleSockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private send(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  private reportError(view: ManagedWebView, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.app.log.warn({ error, credentialId: view.credentialId }, "web account view operation failed");
    this.broadcast(view, { type: "error", message });
  }

  private async enforcePlatformLimit(): Promise<void> {
    const totalLimit = this.app.config.webViewTotalLimit ?? 8;
    if ([...this.views.values()].filter((view) => !view.closed).length >= totalLimit) {
      throw new Error(`系统最多同时运行 ${totalLimit} 个账号页面，请先关闭一个页面`);
    }
  }

  private async closeView(view: ManagedWebView | undefined, reason: string): Promise<void> {
    if (!view || view.closed) return;
    view.closed = true;
    this.app.activeConnections.release(view.runtimeId);
    this.broadcast(view, { type: "closed", reason });
    for (const socket of view.sockets) socket.close(1000, reason.slice(0, 120));
    view.sockets.clear();
    view.visibleSockets.clear();
    await this.stopScreencast(view);
    await view.context.close().catch(() => undefined);
    if (this.views.get(view.key) === view) this.views.delete(view.key);
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [ticket, value] of this.tickets) if (value.expiresAt < now) this.tickets.delete(ticket);
    for (const [id, artifact] of this.downloads) {
      if (now - artifact.createdAt < DOWNLOAD_TTL_MS) continue;
      this.downloads.delete(id);
      try { unlinkSync(artifact.path); } catch { /* Ignore missing expired downloads. */ }
    }
  }

  private issueTicket(ownerId: string, credentialId: string, executionScope: string | null, initiallyVisible: boolean): string {
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { ownerId, credentialId, executionScope, initiallyVisible, expiresAt: Date.now() + TICKET_TTL_MS });
    return ticket;
  }

  private key(ownerId: string, credentialId: string, executionScope: string | null): string {
    return `${ownerId}:${executionScope ?? "web"}:${credentialId}`;
  }

  private profilePath(ownerId: string, credentialId: string, executionScope: string | null): string {
    return executionScope
      ? join(this.profilesRoot, ownerId, `desktop-${executionScope}`, credentialId)
      : join(this.profilesRoot, ownerId, credentialId);
  }

  private downloadPath(ownerId: string, credentialId: string, executionScope: string | null): string {
    return executionScope
      ? join(this.downloadsRoot, ownerId, `desktop-${executionScope}`, credentialId)
      : join(this.downloadsRoot, ownerId, credentialId);
  }
}
