import type { ActiveConnectionItem } from "../shared/active-connection";

type NavigableActiveConnection = Pick<ActiveConnectionItem, "type" | "originEnvironmentId" | "environmentIds">;

export type ActiveConnectionNavigationTarget =
  | { name: "environment"; params: { id: string }; query?: Record<string, string> }
  | { name: "ssh" }
  | { name: "database" }
  | { name: "redis" }
  | { name: "overview" };

export function activeConnectionNavigationTarget(item: NavigableActiveConnection, rememberedEnvironmentId?: string): ActiveConnectionNavigationTarget {
  const environmentId = item.originEnvironmentId
    ?? rememberedEnvironmentId
    ?? (["web", "logs"].includes(item.type) ? item.environmentIds[0] : undefined);
  if (environmentId) return { name: "environment", params: { id: environmentId } };
  if (item.type === "database") return { name: "database" };
  if (item.type === "redis") return { name: "redis" };
  if (item.type === "ssh" || item.type === "sftp") return { name: "ssh" };
  return { name: "overview" };
}

export function activeEnvironmentDockNavigationTarget(
  item: Pick<ActiveConnectionItem, "id" | "type" | "resourceId">,
  environmentId: string,
): ActiveConnectionNavigationTarget {
  const tab = item.type === "sftp" ? "ssh" : item.type;
  return {
    name: "environment",
    params: { id: environmentId },
    query: {
      tab,
      connectionId: item.resourceId,
      activeConnectionId: item.id,
      ...(item.type === "sftp" ? { mode: "sftp" } : {}),
    },
  };
}
