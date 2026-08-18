import { reactive } from "vue";
import { api, clearApiPrefetches, isAuthenticationRequiredError } from "./api";
import { desktopState, isDesktopApp, selectDesktopEndpoint } from "./desktop";

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

export async function loadSession(): Promise<boolean> {
  try {
    if (isDesktopApp()) {
      const state = await desktopState();
      if (!state?.endpoint && !state?.recentEndpoint) {
        clearSession();
        return false;
      }
      if (!state?.endpoint && state?.recentEndpoint) await selectDesktopEndpoint(state.recentEndpoint);
    }
    applyAuth(await api<AuthResponse>("/api/v1/auth/me"));
  } catch {
    clearSession();
  } finally {
    session.loaded = true;
  }
  return Boolean(session.user);
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
