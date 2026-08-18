export type EnvironmentPreloadTab = "ssh" | "logs" | "database" | "redis" | "knowledge" | "maintenance";

export interface EnvironmentPreloadCounts {
  ssh: number;
  logs: number;
  database: number;
  redis: number;
  knowledge: number;
  maintenance: number;
}

export function environmentBackgroundPreloadAllowed(input: {
  active: boolean;
  preview: boolean;
  visible: boolean;
  saveData: boolean;
}): boolean {
  return input.active && !input.preview && input.visible && !input.saveData;
}

export function environmentBackgroundPreloadOrder(
  counts: EnvironmentPreloadCounts,
  activeTab: string,
): EnvironmentPreloadTab[] {
  return (["logs", "knowledge", "redis", "maintenance", "ssh"] as const)
    .filter((tab) => tab !== activeTab && counts[tab] > 0);
}

export function environmentTabUsesIntentOnlyPreload(tab: EnvironmentPreloadTab): boolean {
  return tab === "database";
}
