import { ref } from "vue";
import { ApiError } from "../../api";
import { RESOURCE_TYPE_LABELS, resourceKey, type ResourceRef, type ResourceType } from "../../../shared/organization-rbac";

/** Resource chosen from the overview before opening a grant or request form. */
export const pendingResourceGrant = ref<ResourceRef | null>(null);

export interface NamedCatalogItem {
  type: ResourceType;
  id: string;
  name: string;
  environmentIds: string[];
}

export interface FeatureFlags {
  mcp: boolean;
  agent: boolean;
  webPlugins: boolean;
}

export interface ApprovalFlowGroup {
  flowId: string;
  flowName: string;
  targets: ResourceRef[];
}

const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
export const grantRequestStatusLabel: Record<string, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已拒绝",
  withdrawn: "已撤回",
};

export const DURATION_PRESETS = [
  { id: "30m", label: "30 分钟", ms: 30 * UNIT_MS.minute },
  { id: "1h", label: "1 小时", ms: UNIT_MS.hour },
  { id: "8h", label: "8 小时", ms: 8 * UNIT_MS.hour },
  { id: "1d", label: "1 天", ms: UNIT_MS.day },
  { id: "7d", label: "7 天", ms: 7 * UNIT_MS.day },
  { id: "30d", label: "30 天", ms: 30 * UNIT_MS.day },
  { id: "forever", label: "永久", ms: null },
] as const;

/** Duration is stored as milliseconds and starts when the grant finally takes effect. */
export function durationMilliseconds(amount: number, unit: keyof typeof UNIT_MS): number | null {
  if (!Number.isInteger(amount) || amount < 1) return null;
  const ms = amount * UNIT_MS[unit];
  if (ms > 366 * UNIT_MS.day) return null;
  return ms;
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "永久，从最终生效时起";
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "未记录时长";
  const preset = DURATION_PRESETS.find((item) => item.ms === durationMs);
  if (preset) return `${preset.label}，从最终生效时起`;
  if (durationMs % UNIT_MS.day === 0) return `${durationMs / UNIT_MS.day} 天，从最终生效时起`;
  if (durationMs % UNIT_MS.hour === 0) return `${durationMs / UNIT_MS.hour} 小时，从最终生效时起`;
  if (durationMs % UNIT_MS.minute === 0) return `${durationMs / UNIT_MS.minute} 分钟，从最终生效时起`;
  return `${durationMs} 毫秒，从最终生效时起`;
}

export function linkedResources(catalog: NamedCatalogItem[], environmentId: string) {
  return catalog.filter((item) => item.type !== "environment" && item.environmentIds.includes(environmentId));
}

export function linkedEnvironmentState(catalog: NamedCatalogItem[], selected: ResourceRef[], environmentId: string) {
  const linked = linkedResources(catalog, environmentId);
  if (!linked.length) return "empty" as const;
  const keys = new Set(selected.map(resourceKey));
  const hits = linked.filter((item) => keys.has(resourceKey(item))).length;
  if (hits === 0) return "off" as const;
  if (hits === linked.length) return "on" as const;
  return "partial" as const;
}

function addTargets(selected: ResourceRef[], items: ResourceRef[]) {
  const map = new Map(selected.map((target) => [resourceKey(target), target]));
  for (const item of items) map.set(resourceKey(item), { type: item.type, id: item.id });
  return [...map.values()];
}

/** Same linked-resource batching as the approval scope picker. It does not add the environment row. */
export function toggleLinkedEnvironment(catalog: NamedCatalogItem[], selected: ResourceRef[], environmentId: string, checked: boolean) {
  const linked = linkedResources(catalog, environmentId);
  if (checked) return addTargets(selected, linked.map(({ type, id }) => ({ type, id })));
  const remove = new Set(linked.map(resourceKey));
  for (const environment of catalog.filter((item) => item.type === "environment")) {
    if (environment.id === environmentId || linkedEnvironmentState(catalog, selected, environment.id) !== "on") continue;
    for (const item of linkedResources(catalog, environment.id)) remove.delete(resourceKey(item));
  }
  return selected.filter((target) => !remove.has(resourceKey(target)));
}

export function toggleResource(selected: ResourceRef[], target: ResourceRef, checked: boolean) {
  if (checked) return addTargets(selected, [target]);
  const key = resourceKey(target);
  return selected.filter((item) => resourceKey(item) !== key);
}

/** Application batches keep an empty environment as itself and preview the current fixed resources. */
export function toggleApplicationEnvironment(catalog: NamedCatalogItem[], selected: ResourceRef[], environmentId: string, checked: boolean) {
  const next = toggleLinkedEnvironment(catalog, selected, environmentId, checked);
  const environment = { type: "environment" as const, id: environmentId };
  return checked ? addTargets(next, [environment]) : next.filter((target) => resourceKey(target) !== resourceKey(environment));
}

export function applicationEnvironmentState(catalog: NamedCatalogItem[], selected: ResourceRef[], environmentId: string) {
  const linked = linkedEnvironmentState(catalog, selected, environmentId);
  const environmentSelected = selected.some((target) => target.type === "environment" && target.id === environmentId);
  if (linked === "empty") return environmentSelected ? "empty-on" as const : "empty" as const;
  if (environmentSelected && linked === "on") return "on" as const;
  if (!environmentSelected && linked === "off") return "off" as const;
  return "partial" as const;
}

export function catalogLabel(catalog: NamedCatalogItem[], target: ResourceRef & { name?: string; typeName?: string; environmentName?: string }) {
  const named = catalog.find((item) => resourceKey(item) === resourceKey(target));
  const typeName = target.typeName || RESOURCE_TYPE_LABELS[target.type] || target.type;
  const name = target.name?.trim() || named?.name?.trim() || "";
  const environment = target.environmentName?.trim() || (named?.environmentIds.length ? `${named.environmentIds.length} 个关联环境` : "");
  const title = name ? `${typeName} · ${name}` : `${typeName} · 未命名资源`;
  return environment && target.type !== "environment" ? `${title} · ${environment}` : title;
}

export function hasEnvironmentTarget(targets: Array<{ type: string }>) {
  return targets.some((target) => target.type === "environment");
}

/** Web plugins apply only to a group that still contains an environment. Other flags stay with their own targets. */
export function featuresForTargets(features: FeatureFlags, targets: Array<{ type: string }>): FeatureFlags {
  return {
    mcp: features.mcp,
    agent: features.agent,
    webPlugins: features.webPlugins && hasEnvironmentTarget(targets),
  };
}

export function featuresSubmittable(features: FeatureFlags) {
  return features.mcp || features.agent || features.webPlugins;
}

function isGroup(value: unknown): value is ApprovalFlowGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as ApprovalFlowGroup;
  return typeof group.flowId === "string" && typeof group.flowName === "string" && Array.isArray(group.targets)
    && group.targets.every((target) => target && typeof target.type === "string" && typeof target.id === "string");
}

export function approvalFlowGroups(error: unknown): ApprovalFlowGroup[] | null {
  if (!(error instanceof ApiError) || error.code !== "MULTIPLE_APPROVAL_FLOWS" || error.status !== 409) return null;
  const groups = error.details.groups;
  if (!Array.isArray(groups) || !groups.every(isGroup)) return null;
  return groups.map((group) => ({
    flowId: group.flowId,
    flowName: group.flowName,
    targets: group.targets.map((target) => ({ type: target.type, id: target.id })),
  }));
}
