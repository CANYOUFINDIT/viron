import {
  CAPABILITIES,
  CAPABILITY_ACTIONS,
  type Capability,
  type ScopeKind,
  expandActions,
} from "../../../shared/access-permissions";

export interface GrantDetailSource {
  resourceId: string;
  label?: string;
  scopeKind?: ScopeKind;
  resourceType?: ScopeKind;
  wholeGroup?: boolean;
  groupId?: string | null;
  targetIds?: string[];
  permissions?: Record<string, string[]>;
  items?: Record<string, string[]>;
}

export interface GrantScopeResource {
  id: string;
  name: string;
  type: ScopeKind;
  groupId?: string | null;
}

export interface GrantScopeItem {
  id: string;
  name: string;
  environmentName?: string;
  unavailable?: boolean;
}

export type GrantScopeCatalog = Partial<Record<Capability, GrantScopeItem[]>>;

export function grantEnvironmentIds(grant: GrantDetailSource, resources: readonly GrantScopeResource[]): string[] {
  const kind = grant.scopeKind ?? grant.resourceType;
  if (kind === "environment_group" && grant.wholeGroup) {
    return resources.filter((resource) => resource.type === "environment" && resource.groupId === (grant.groupId ?? grant.resourceId)).map((resource) => resource.id);
  }
  return kind === "environment" ? [...new Set(grant.targetIds ?? [grant.resourceId])] : [];
}

export function grantPermissionRows(grant: GrantDetailSource, catalog: GrantScopeCatalog, resources: readonly GrantScopeResource[]) {
  const kind = grant.scopeKind ?? grant.resourceType;
  const connection = kind?.endsWith("_connection") ?? false;
  return CAPABILITIES.flatMap((capability) => {
    const selected = expandActions(capability, grant.permissions?.[capability] ?? []);
    if (!selected.length) return [];
    const specified = grant.items?.[capability] ?? [];
    const all = !connection && !specified.length;
    const available = [...new Map((catalog[capability] ?? []).map((item) => [item.id, item])).values()];
    const ids = connection ? grant.targetIds ?? [grant.resourceId] : specified;
    const items: GrantScopeItem[] = all ? available : ids.map((id) => {
      const item = connection ? resources.find((resource) => resource.type === kind && resource.id === id) : available.find((item) => item.id === id);
      return item ? { ...item } : { id, name: "资源信息不可用", unavailable: true };
    });
    return [{
      capability,
      actions: CAPABILITY_ACTIONS[capability].map((id) => ({ id, selected: selected.includes(id) })),
      all,
      items,
    }];
  });
}
