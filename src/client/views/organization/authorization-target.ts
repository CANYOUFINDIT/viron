import { resourceKey, type ResourceRef } from "../../../shared/organization-rbac";

export type AuthorizationDataScope = "environment" | "related";

export interface SingleTargetGrantEdit {
  resource: ResourceRef & { name?: string };
  kind: "data" | "feature";
  id: string;
  revision: string;
  enabled: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  features?: { mcp: boolean; agent: boolean; webPlugins: boolean };
  roleId?: string;
  roleName?: string;
  permissionCodes?: string[];
  subjectType?: "user" | "project" | "organization";
  subjectId?: string;
  subjectName?: string;
}

type CatalogTarget = ResourceRef & { environmentIds: string[] };

/** Exact selection keeps an environment record by itself. Related mode adds only resources linked now. */
export function resolveAuthorizationTargets<T extends CatalogTarget>(
  catalog: T[],
  selectedKeys: string[],
  mode: "exact" | "related",
): T[] {
  const selected = new Set(selectedKeys);
  const picked = catalog.filter((item) => selected.has(resourceKey(item)));
  if (mode === "exact") return picked;
  const environments = new Set(picked.filter((item) => item.type === "environment").map((item) => item.id));
  if (!environments.size) return picked;
  return catalog.filter(
    (item) => selected.has(resourceKey(item)) || item.environmentIds.some((id) => environments.has(id)),
  );
}

export function authorizationStatusText(status: string | null | undefined) {
  if (status === "active") return "生效中";
  if (status === "disabled") return "已停用";
  if (status === "pending") return "未生效";
  if (status === "expired") return "已过期";
  return status || "未知状态";
}

export function authorizationOriginText(origin: string | null | undefined) {
  if (origin === "direct") return "直接授权";
  if (origin === "request") return "审批授权";
  return origin || "未知来源";
}

export function featureSubjectText(subjectType: string | null | undefined) {
  if (subjectType === "user") return "成员";
  if (subjectType === "project") return "子组织";
  if (subjectType === "organization") return "组织及所有成员";
  return subjectType || "对象";
}
