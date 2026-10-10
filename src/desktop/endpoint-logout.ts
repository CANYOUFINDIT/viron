import type { Session } from "electron";
import { readState } from "./app-state.js";
import { endpointSession } from "./device-session.js";
import { activeEndpoint, setActiveEndpoint } from "./endpoint-context.js";
import { closeAllServiceSockets, closeDesktopExecution } from "./execution-router.js";
import { translate as tr } from "./i18n.js";
import { closeDesktopMcpOperations } from "./mcp-desktop-bridge.js";
import { closeAllDesktopWebViews } from "./web-view-runtime.js";

async function clearEndpointSession(endpoint: string, partition: Session): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Revoke the remote session when reachable, but never let it block local logout.
    await Promise.race([
      partition.fetch(`${endpoint}/api/v1/auth/logout`, {
        method: "POST", credentials: "include", redirect: "error", signal: controller.signal,
      }).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(); }, 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await partition.cookies.remove(endpoint, "envman_session");
    await partition.cookies.flushStore();
  }
}

export async function logoutDesktopEndpoint(): Promise<void> {
  const current = activeEndpoint;
  const endpoint = current?.endpoint ?? readState().recentEndpoint;
  const partition = current?.partition ?? (endpoint ? endpointSession(endpoint) : null);
  const reason = tr("用户已退出登录");

  // Detach first so resource cleanup cannot make requests to an offline Endpoint.
  setActiveEndpoint(null);
  closeAllServiceSockets(reason);
  await Promise.all([
    endpoint && partition ? clearEndpointSession(endpoint, partition) : Promise.resolve(),
    closeDesktopMcpOperations(false),
    closeAllDesktopWebViews(),
    closeDesktopExecution(reason),
  ]);
}
