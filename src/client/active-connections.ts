import { reactive } from "vue";
import type { ActiveConnectionItem, ActiveConnectionSummary } from "../shared/active-connection";
import { api } from "./api";

export const activeConnections = reactive<ActiveConnectionSummary & { loading: boolean }>({
  current: 0,
  limit: 30,
  idleMinutes: 30,
  items: [],
  loading: false,
});

let activeConnectionsLoad: Promise<void> | null = null;
let activeConnectionsReloadRequested = false;

export function loadActiveConnections(): Promise<void> {
  if (activeConnectionsLoad) {
    activeConnectionsReloadRequested = true;
    return activeConnectionsLoad;
  }
  activeConnections.loading = true;
  activeConnectionsLoad = (async () => {
    do {
      activeConnectionsReloadRequested = false;
      const response = await api<ActiveConnectionSummary>("/api/v1/active-connections");
      Object.assign(activeConnections, response);
    } while (activeConnectionsReloadRequested);
  })().finally(() => {
    activeConnections.loading = false;
    activeConnectionsLoad = null;
  });
  return activeConnectionsLoad;
}

export async function closeActiveConnection(item: ActiveConnectionItem): Promise<void> {
  await closeActiveConnections([item]);
}

export async function closeActiveConnections(items: readonly ActiveConnectionItem[]): Promise<void> {
  const results = await Promise.allSettled(items.map((item) => api(`/api/v1/active-connections/${item.id}`, { method: "DELETE" })));
  await loadActiveConnections();
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}
