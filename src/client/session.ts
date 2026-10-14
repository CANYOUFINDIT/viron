import { reactive } from "vue";
import { api, clearApiPrefetches, isAuthenticationRequiredError } from "./api";
import { clearDesktopEndpoint, desktopState, isDesktopApp, selectDesktopEndpoint } from "./desktop";
import { translate as tr } from "./i18n";

export const SESSION_INITIALIZATION_TIMEOUT_MS = 15_000;
export const sessionInitialization = reactive({
  pending: false,
  phase: "endpoint" as "endpoint" | "validation" | "session",
  endpoint: "",
  elapsedSeconds: 0,
  error: "",
});

export class SessionInitializationCancelledError extends Error {}
class SessionInitializationTimeoutError extends Error {}
let initializationController: AbortController | null = null;
let initializationPromise: Promise<boolean> | null = null;

export function cancelSessionInitialization(): void {
  initializationController?.abort(new SessionInitializationCancelledError());
  initializationController = null;
  initializationPromise = null;
  sessionInitialization.pending = false;
  sessionInitialization.error = "";
}

function initializationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SessionInitializationTimeoutError || /ENDPOINT_TIMEOUT|连接 Endpoint 超时|Connection Endpoint timeout|ERR_TIMED_OUT|登录状态请求超时|session request timed out/i.test(message)) {
    return sessionInitialization.phase === "session"
      ? tr("Endpoint 已通过验证，但读取登录状态超时。服务可能繁忙或其数据库响应缓慢，请稍后重试。")
      : tr("验证 Endpoint 超时。请检查网络、代理和服务是否可访问。");
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)) return tr("无法解析 Endpoint 域名，请检查地址和 DNS 设置。");
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(message)) return tr("Endpoint 拒绝连接，请检查服务是否启动以及地址和端口是否正确。");
  if (/ERR_CERT_|certificate|证书/i.test(message)) return tr("Endpoint 的 HTTPS 证书验证失败，请检查服务证书。");
  return message || tr("无法完成登录初始化，请检查 Endpoint 后重试。");
}

export interface PlatformUser {
  id: string;
  username: string;
  isPlatformAdmin: boolean;
  createdAt: string;
}

export interface Workspace {
  type: "personal" | "organization";
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  permissionCodes?: string[];
}

export const session = reactive<{
  user: PlatformUser | null;
  workspace: Workspace | null;
  workspaces: Workspace[];
  loaded: boolean;
}>({
  user: null,
  workspace: null,
  workspaces: [],
  loaded: false,
});

interface AuthResponse {
  user: PlatformUser;
  workspace: Workspace;
  workspaces: Workspace[];
}

function applyAuth(response: AuthResponse): void {
  clearApiPrefetches();
  session.user = response.user;
  session.workspace = response.workspace;
  session.workspaces = response.workspaces;
}

export function clearSession(): void {
  clearApiPrefetches();
  session.user = null;
  session.workspace = null;
  session.workspaces = [];
}

export function loadSession(): Promise<boolean> {
  if (initializationPromise) return initializationPromise;
  const controller = new AbortController();
  initializationController = controller;
  Object.assign(sessionInitialization, { pending: true, phase: "endpoint", endpoint: "", elapsedSeconds: 0, error: "" });
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    if (initializationController === controller) sessionInitialization.elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  }, 1000);
  const timeout = setTimeout(() => controller.abort(new SessionInitializationTimeoutError()), SESSION_INITIALIZATION_TIMEOUT_MS);
  let removeAbortListener = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", abort);
  });
  const initialize = async () => {
    if (isDesktopApp()) {
      const state = await desktopState();
      controller.signal.throwIfAborted();
      sessionInitialization.endpoint = state?.endpoint ?? state?.recentEndpoint ?? "";
      if (!state?.endpoint && !state?.recentEndpoint) {
        clearSession();
        session.loaded = true;
        return false;
      }
      if (!state?.endpoint && state?.recentEndpoint) {
        sessionInitialization.phase = "validation";
        await selectDesktopEndpoint(state.recentEndpoint);
        controller.signal.throwIfAborted();
      }
    }
    sessionInitialization.phase = "session";
    const response = await api<AuthResponse>("/api/v1/auth/me", { signal: controller.signal });
    controller.signal.throwIfAborted();
    applyAuth(response);
    session.loaded = true;
    return Boolean(session.user);
  };
  const pending = Promise.race([initialize(), cancelled]).catch((error: unknown) => {
    if (error instanceof SessionInitializationCancelledError) throw error;
    if (initializationController === controller) sessionInitialization.error = initializationErrorMessage(error);
    if (!isAuthenticationRequiredError(error)) throw error;
    clearSession();
    session.loaded = true;
    sessionInitialization.error = "";
    return false;
  }).finally(() => {
    clearInterval(ticker);
    clearTimeout(timeout);
    removeAbortListener();
    if (initializationController === controller) {
      sessionInitialization.pending = false;
      initializationController = null;
      initializationPromise = null;
    }
  });
  initializationPromise = pending;
  return pending;
}

export async function login(username: string, password: string): Promise<void> {
  const response = await api<AuthResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  applyAuth(response);
  session.loaded = true;
}

export async function register(username: string, password: string): Promise<void> {
  const response = await api<AuthResponse>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  applyAuth(response);
  session.loaded = true;
}

export async function switchWorkspace(workspace: Workspace): Promise<void> {
  const response = await api<AuthResponse>("/api/v1/auth/workspace", {
    method: "PUT",
    body: JSON.stringify(workspace.type === "personal" ? { type: "personal" } : { type: "organization", id: workspace.id }),
  });
  applyAuth(response);
}

export async function logout(): Promise<"logged-out" | "session-expired"> {
  cancelSessionInitialization();
  if (isDesktopApp()) {
    await clearDesktopEndpoint();
    clearSession();
    session.loaded = true;
    return "logged-out";
  }
  let result: "logged-out" | "session-expired" = "logged-out";
  try {
    await api<void>("/api/v1/auth/logout", { method: "POST" });
  } catch (error) {
    if (!isAuthenticationRequiredError(error)) throw error;
    result = "session-expired";
  }
  clearSession();
  return result;
}

export function workspaceCan(code: string): boolean {
  return (session.workspace?.type === "personal" && session.workspace.role === "owner") || session.workspace?.permissionCodes?.includes(code) === true;
}
