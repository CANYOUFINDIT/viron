import { randomUUID } from "node:crypto";
import type { EnvmanDatabase } from "./database-client.js";
import {
  OrganizationPermissionError,
  insertDataGrant,
  loadOrganizationAccess,
  organizationResourceCatalog,
  roleState,
} from "./organization-rbac.js";
import { resourceKey, validAt, type ResourceRef } from "../shared/organization-rbac.js";
import { serverNow } from "./organization-boundary.js";

export type FlowMode = "any" | "all" | "sequence" | "auto_approve" | "auto_reject" | "cc";
export interface FlowNode {
  id: string;
  name: string;
  mode: FlowMode;
  approverUserIds: string[];
  approverRoleId: string | null;
  allowSelf: boolean;
  requireComment: boolean;
}
export interface FlowSnapshotNode extends FlowNode {
  resolvedApproverIds: string[];
  /** Members who held approval.approve for these targets when the request was submitted. */
  passApproverIds: string[];
  resolution: string;
}
interface RequestRow {
  id: string;
  organization_id: string;
  requester_id: string;
  kind: "data" | "feature";
  role_id: string | null;
  features_json: string | null;
  targets_json: string;
  duration_ms: number | null;
  permission_snapshot_json: string;
  workflow_snapshot_json: string;
  decisions_json: string;
  status: string;
  stage_index: number | string;
  grant_ids_json: string;
  block_reason: string;
  reason: string;
  version: number | string;
}

const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};
const human = new Set<FlowMode>(["any", "all", "sequence"]);

type LedgerActor = { id?: string | null; name?: string | null; username?: string | null };

function ledgerActorName(actor: LedgerActor): string {
  return actor.name?.trim() || actor.username?.trim() || "系统";
}

export async function recordGrantLedger(
  db: EnvmanDatabase,
  org: string,
  actor: LedgerActor,
  action: string,
  reason: string,
  details: {
    before?: unknown;
    after?: unknown;
    targets?: ResourceRef[];
    requestId?: string | null;
    grantId?: string | null;
    channel?: string | null;
  } = {},
) {
  await db
    .prepare(
      `INSERT INTO organization_grant_ledger (
        id, organization_id, actor_id, actor_name, action, reason, before_json, after_json,
        target_refs_json, request_id, grant_id, channel, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      org,
      actor.id ?? null,
      ledgerActorName(actor),
      action,
      reason,
      details.before === undefined ? null : JSON.stringify(details.before),
      details.after === undefined ? null : JSON.stringify(details.after),
      JSON.stringify(details.targets ?? []),
      details.requestId ?? null,
      details.grantId ?? null,
      details.channel ?? null,
      new Date().toISOString(),
    );
}

async function activeMembers(db: EnvmanDatabase, org: string) {
  return db
    .prepare(
      `SELECT m.user_id FROM organization_members m JOIN admin_users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND u.status = 'active'`,
    )
    .all<{ user_id: string }>(org);
}

async function projectTree(db: EnvmanDatabase, org: string) {
  const projects = await db
    .prepare("SELECT id, parent_id FROM projects WHERE organization_id = ?")
    .all<{ id: string; parent_id: string | null }>(org);
  const membership = await db
    .prepare(
      `SELECT pm.project_id, pm.user_id FROM project_members pm
       JOIN projects p ON p.id = pm.project_id WHERE p.organization_id = ?`,
    )
    .all<{ project_id: string; user_id: string }>(org);
  const descendants = (id: string) => {
    const ids = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const project of projects)
        if (project.parent_id && ids.has(project.parent_id) && !ids.has(project.id)) {
          ids.add(project.id);
          grew = true;
        }
    }
    return ids;
  };
  return { projects, membership, descendants };
}

export async function roleHolderIds(db: EnvmanDatabase, org: string, roleId: string, now = serverNow()) {
  const [state, members, tree] = await Promise.all([
    roleState(db, org),
    activeMembers(db, org),
    projectTree(db, org),
  ]);
  const memberIds = new Set(members.map((member) => member.user_id));
  const holders = new Set<string>();
  for (const assignment of state.assignments) {
    if (assignment.roleId !== roleId || !validAt(assignment, now)) continue;
    if (assignment.subjectType === "user" && memberIds.has(assignment.subjectId))
      holders.add(assignment.subjectId);
    if (assignment.subjectType === "organization" && assignment.subjectId === org)
      memberIds.forEach((id) => holders.add(id));
    if (assignment.subjectType === "project")
      for (const row of tree.membership)
        if (tree.descendants(assignment.subjectId).has(row.project_id) && memberIds.has(row.user_id))
          holders.add(row.user_id);
  }
  return [...holders].sort();
}

export async function ensureDefaultApprovalFlow(db: EnvmanDatabase, org: string) {
  const existing = await db
    .prepare(
      "SELECT id FROM organization_approval_flows WHERE organization_id = ? AND is_default = 1",
    )
    .get<{ id: string }>(org);
  if (existing) return existing.id;
  const role = await db
    .prepare(
      `SELECT id FROM organization_roles WHERE organization_id = ? AND enabled = 1
       AND permission_codes_json LIKE ? ORDER BY created_at, id LIMIT 1`,
    )
    .get<{ id: string }>(org, '%"approval.approve"%');
  const now = new Date().toISOString();
  const id = randomUUID();
  const nodes: FlowNode[] = [
    {
      id: randomUUID(),
      name: "组织审批",
      mode: "any",
      approverUserIds: [],
      approverRoleId: role?.id ?? null,
      allowSelf: false,
      requireComment: false,
    },
  ];
  await db
    .prepare(
      `INSERT INTO organization_approval_flows (
        id, organization_id, name, is_default, enabled, nodes_json, created_at, updated_at
      ) VALUES (?, ?, ?, 1, 1, ?, ?, ?)`,
    )
    .run(id, org, "所有连接", JSON.stringify(nodes), now, now);
  await recordGrantLedger(db, org, { name: "系统" }, "建立默认审批流程", "承接未分配的资源", {
    after: { id, name: "所有连接" },
  });
  return id;
}

async function flows(db: EnvmanDatabase, org: string) {
  await ensureDefaultApprovalFlow(db, org);
  const rows = await db
    .prepare(
      "SELECT * FROM organization_approval_flows WHERE organization_id = ? ORDER BY is_default DESC, created_at, id",
    )
    .all<Record<string, unknown>>(org);
  const targets = await db
    .prepare(
      "SELECT target_type, target_id, flow_id FROM organization_approval_flow_targets WHERE organization_id = ?",
    )
    .all<{ target_type: ResourceRef["type"]; target_id: string; flow_id: string }>(org);
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    isDefault: Number(row.is_default) === 1,
    enabled: Number(row.enabled) === 1,
    version: Number(row.version),
    nodes: parse<FlowNode[]>(row.nodes_json, []),
    targets: targets
      .filter((target) => target.flow_id === row.id)
      .map((target) => ({ type: target.target_type, id: target.target_id })),
  }));
}

export async function listApprovalFlows(db: EnvmanDatabase, org: string) {
  const catalog = await organizationResourceCatalog(db, org);
  const items = await flows(db, org);
  const owned = new Set(items.flatMap((item) => item.targets.map(resourceKey)));
  return {
    items: items.map((item) => ({
      ...item,
      coverage: item.isDefault
        ? catalog.filter((target) => !owned.has(resourceKey(target))).length
        : item.targets.length,
    })),
  };
}

function sameTarget(left: ResourceRef, right: ResourceRef) {
  return left.type === right.type && left.id === right.id;
}

export async function saveApprovalFlow(
  db: EnvmanDatabase,
  org: string,
  actor: LedgerActor,
  input: { id?: string; name: string; nodes: FlowNode[]; targets: ResourceRef[] },
) {
  const catalog = await organizationResourceCatalog(db, org);
  const known = new Set(catalog.map(resourceKey));
  const targets = [...new Map(input.targets.map((target) => [resourceKey(target), target])).values()];
  if (targets.some((target) => !known.has(resourceKey(target))))
    throw new OrganizationPermissionError("INVALID_RESOURCE", 400, "审批范围包含不存在的资源");
  return db.transaction(async () => {
    await db.prepare("UPDATE organizations SET updated_at = updated_at WHERE id = ?").run(org);
    const current = await flows(db, org);
    const flow = input.id ? current.find((item) => item.id === input.id) : undefined;
    if (input.id && !flow) throw new OrganizationPermissionError("NOT_FOUND", 404, "审批流程不存在");
    if (flow?.isDefault && targets.length)
      throw new OrganizationPermissionError("DEFAULT_FLOW_REQUIRED", 409, "默认流程必须继续承接未分配的资源");
    if (!flow?.isDefault && !targets.length)
      throw new OrganizationPermissionError("FLOW_SCOPE_REQUIRED", 400, "指定流程至少选择一个资源");
    const modes = new Set<FlowMode>(["any", "all", "sequence", "auto_approve", "auto_reject", "cc"]);
    if (!input.nodes.length || input.nodes.some((node) => !modes.has(node.mode)))
      throw new OrganizationPermissionError("INVALID_APPROVAL_NODE", 400, "审批节点必须保留原有模式，不能降级或留空");
    const conflicts = targets.flatMap((target) => {
      const owner = current.find(
        (item) => !item.isDefault && item.id !== flow?.id && item.targets.some((owned) => sameTarget(owned, target)),
      );
      return owner ? [{ target, flowName: owner.name }] : [];
    });
    if (conflicts.length)
      throw new OrganizationPermissionError(
        "APPROVAL_SCOPE_CONFLICT",
        409,
        `这些资源已经属于其他流程：${conflicts.map((item) => catalog.find((resource) => sameTarget(resource, item.target))?.name ?? item.target.id).join("、")}`,
      );
    const now = new Date().toISOString();
    const id = flow?.id ?? randomUUID();
    if (flow)
      await db
        .prepare(
          "UPDATE organization_approval_flows SET name = ?, nodes_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(input.name, JSON.stringify(input.nodes), now, id);
    else
      await db
        .prepare(
          `INSERT INTO organization_approval_flows (
            id, organization_id, name, is_default, enabled, nodes_json, created_at, updated_at
          ) VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
        )
        .run(id, org, input.name, JSON.stringify(input.nodes), now, now);
    if (!flow?.isDefault) {
      await db.prepare("DELETE FROM organization_approval_flow_targets WHERE organization_id = ? AND flow_id = ?").run(org, id);
      for (const target of targets)
        await db
          .prepare(
            "INSERT INTO organization_approval_flow_targets (organization_id, target_type, target_id, flow_id) VALUES (?, ?, ?, ?)",
          )
          .run(org, target.type, target.id, id);
    }
    await recordGrantLedger(db, org, actor, flow ? "修改审批流程" : "新增审批流程", "审批范围与保存同一事务", {
      before: flow ?? null,
      after: { id, name: input.name, targets },
      targets,
    });
    return { id };
  })();
}

export async function deleteApprovalFlow(
  db: EnvmanDatabase,
  org: string,
  actor: LedgerActor,
  flowId: string,
) {
  const current = await flows(db, org);
  const flow = current.find((item) => item.id === flowId);
  if (!flow) throw new OrganizationPermissionError("NOT_FOUND", 404, "审批流程不存在");
  if (flow.isDefault)
    throw new OrganizationPermissionError("DEFAULT_FLOW_REQUIRED", 409, "不能删除承接未分配资源的默认流程");
  await db.transaction(async () => {
    await db.prepare("DELETE FROM organization_approval_flow_targets WHERE organization_id = ? AND flow_id = ?").run(org, flowId);
    await db.prepare("DELETE FROM organization_approval_flows WHERE organization_id = ? AND id = ? AND is_default = 0").run(org, flowId);
    await recordGrantLedger(db, org, actor, "删除审批流程", "新申请回到默认流程，已提交申请仍读原快照", {
      before: flow,
      targets: flow.targets,
    });
  })();
}

function flowFor(all: Awaited<ReturnType<typeof flows>>, target: ResourceRef) {
  return (
    all.find((item) => !item.isDefault && item.targets.some((owned) => sameTarget(owned, target))) ??
    all.find((item) => item.isDefault)!
  );
}

function coversApproval(access: Awaited<ReturnType<typeof loadOrganizationAccess>>, code: "approval.approve" | "approval.reject", targets: ResourceRef[]) {
  if (access.allows(code)) return true;
  return targets.length > 0 && targets.every((target) => access.allows(code, target));
}

/** Node membership is approve or reject on the current targets. Each decision still checks its own code. */
async function approverCapabilities(db: EnvmanDatabase, org: string, userIds: string[], targets: ResourceRef[]) {
  const capabilities = new Map<string, { approve: boolean; reject: boolean }>();
  for (const userId of userIds) {
    if (capabilities.has(userId)) continue;
    const access = await loadOrganizationAccess(db, org, userId);
    const approve = coversApproval(access, "approval.approve", targets);
    const reject = coversApproval(access, "approval.reject", targets);
    if (approve || reject) capabilities.set(userId, { approve, reject });
  }
  return capabilities;
}

async function resolveNode(
  db: EnvmanDatabase,
  org: string,
  node: FlowNode,
  requesterId: string,
  targets: ResourceRef[],
): Promise<FlowSnapshotNode> {
  let ids = [...node.approverUserIds];
  let resolution = ids.length ? "指定成员" : "";
  if (node.approverRoleId) {
    const holders = await roleHolderIds(db, org, node.approverRoleId);
    ids = [...new Set([...ids, ...holders])];
    resolution = resolution ? `${resolution}；角色成员` : "角色成员";
  }
  if (!node.allowSelf) ids = ids.filter((id) => id !== requesterId);
  const capabilities = human.has(node.mode) ? await approverCapabilities(db, org, ids, targets) : null;
  const resolved = capabilities ? ids.filter((id) => capabilities.has(id)) : ids;
  const passApproverIds = capabilities ? resolved.filter((id) => capabilities.get(id)?.approve) : [];
  if (human.has(node.mode) && !resolved.length)
    throw new OrganizationPermissionError("APPROVER_UNAVAILABLE", 409, `节点“${node.name}”没有可审批的人，不能提交`);
  return { ...node, resolvedApproverIds: resolved, passApproverIds, resolution: resolution || node.mode };
}

interface PermissionSnapshot {
  permissionCodes: string[];
  holderIds: string[];
  targets: ResourceRef[];
  features: FeatureGrantFeatures | null;
  durationMs: number | null;
}
type FeatureGrantFeatures = { mcp: boolean; agent: boolean; webPlugins: boolean };

export async function submitGrantRequest(
  db: EnvmanDatabase,
  org: string,
  requesterId: string,
  input: {
    kind: "data" | "feature";
    roleId?: string | null;
    features?: FeatureGrantFeatures | null;
    targets: ResourceRef[];
    durationMs: number | null;
    reason: string;
  },
) {
  const now = serverNow();
  const access = await loadOrganizationAccess(db, org, requesterId, now);
  if (!access.allows("authorization.request"))
    throw new OrganizationPermissionError("ACTION_FORBIDDEN", 403, "没有申请授权的权限");
  const catalog = access.catalog;
  const targets = [...new Map(input.targets.map((target) => [resourceKey(target), target])).values()];
  if (!targets.length || targets.some((target) => !catalog.some((item) => sameTarget(item, target))))
    throw new OrganizationPermissionError("INVALID_RESOURCE", 400, "申请目标不存在");
  if (input.kind === "data") {
    if (!input.roleId) throw new OrganizationPermissionError("ROLE_REQUIRED", 400, "数据申请必须选择已经持有的角色");
    const holders = await roleHolderIds(db, org, input.roleId, now);
    if (!holders.includes(requesterId))
      throw new OrganizationPermissionError("ROLE_NOT_HELD", 409, "只能为自己已经持有的角色申请数据授权");
  } else if (input.roleId) {
    throw new OrganizationPermissionError("FEATURE_ROLE_FORBIDDEN", 400, "功能申请不选择角色");
  }
  const features = input.kind === "feature" ? input.features ?? null : null;
  if (input.kind === "feature" && (!features || (!features.mcp && !features.agent && !features.webPlugins)))
    throw new OrganizationPermissionError("FEATURE_REQUIRED", 400, "功能申请至少选择一项功能");
  if (features?.webPlugins && !targets.some((target) => target.type === "environment"))
    throw new OrganizationPermissionError("INVALID_PLUGIN_SCOPE", 400, "Web 插件只能按环境申请");
  const all = await flows(db, org);
  const grouped = new Map<string, ResourceRef[]>();
  for (const target of targets) {
    const flow = flowFor(all, target);
    grouped.set(flow.id, [...(grouped.get(flow.id) ?? []), target]);
  }
  if (grouped.size > 1)
    throw new OrganizationPermissionError(
      "MULTIPLE_APPROVAL_FLOWS",
      409,
      "这些资源分属不同审批流程，请按流程分别提交",
    );
  const flow = all.find((item) => item.id === [...grouped.keys()][0])!;
  const snapshotNodes: FlowSnapshotNode[] = [];
  for (const node of flow.nodes)
    snapshotNodes.push(await resolveNode(db, org, node, requesterId, targets));
  const role = input.roleId ? access.state.roles.find((item) => item.id === input.roleId) : undefined;
  const permissionSnapshot: PermissionSnapshot = {
    permissionCodes: [...(role?.permissionCodes ?? [])].sort(),
    holderIds: input.roleId ? await roleHolderIds(db, org, input.roleId, now) : [requesterId],
    targets,
    features,
    durationMs: input.durationMs,
  };
  const id = randomUUID();
  const created = new Date(now).toISOString();
  let status = "pending";
  let stage = 0;
  const decisions: Array<Record<string, unknown>> = [];
  while (stage < snapshotNodes.length && !human.has(snapshotNodes[stage].mode)) {
    const node = snapshotNodes[stage];
    if (node.mode === "auto_reject") {
      status = "rejected";
      decisions.push({ stageIndex: stage, decision: "reject", at: created, automatic: true });
      break;
    }
    decisions.push({ stageIndex: stage, decision: node.mode === "cc" ? "cc" : "approve", at: created, automatic: true });
    stage += 1;
    if (node.mode === "auto_approve" && stage >= snapshotNodes.length) status = "approved";
  }
  const grantIds = status === "approved"
    ? await grantApproved(db, org, requesterId, input.kind, permissionSnapshot, id, now, input.roleId ?? null)
    : [];
  await db
    .prepare(
      `INSERT INTO organization_grant_requests (
        id, organization_id, requester_id, kind, role_id, features_json, targets_json, duration_ms,
        permission_snapshot_json, workflow_snapshot_json, decisions_json, status, stage_index,
        grant_ids_json, block_reason, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    )
    .run(
      id,
      org,
      requesterId,
      input.kind,
      input.roleId ?? null,
      features ? JSON.stringify(features) : null,
      JSON.stringify(targets),
      input.durationMs,
      JSON.stringify(permissionSnapshot),
      JSON.stringify({ flowId: flow.id, flowName: flow.name, nodes: snapshotNodes }),
      JSON.stringify(decisions),
      status,
      stage,
      JSON.stringify(grantIds),
      input.reason,
      created,
      created,
    );
  await recordGrantLedger(db, org, { id: requesterId, name: requesterId }, "提交授权申请", input.reason, {
    after: { id, kind: input.kind, status },
    targets,
    requestId: id,
  });
  return { id, status, grantIds };
}

async function grantApproved(
  db: EnvmanDatabase,
  org: string,
  requesterId: string,
  kind: "data" | "feature",
  snapshot: PermissionSnapshot,
  requestId: string,
  now: number,
  roleId: string | null,
) {
  const startsAt = new Date(now).toISOString();
  const expiresAt = snapshot.durationMs === null ? null : new Date(now + snapshot.durationMs).toISOString();
  const ids: string[] = [];
  if (kind === "data") {
    if (!roleId) throw new OrganizationPermissionError("ROLE_REQUIRED", 409, "数据申请缺少角色");
    const holders = await roleHolderIds(db, org, roleId, now);
    const role = (await roleState(db, org)).roles.find((item) => item.id === roleId);
    if (!role?.enabled || !holders.includes(requesterId))
      throw new OrganizationPermissionError("ROLE_NOT_HELD", 409, "申请人已经不再持有该角色，不能授予");
    if ([...role.permissionCodes].sort().join("\0") !== snapshot.permissionCodes.join("\0") || holders.join("\0") !== snapshot.holderIds.join("\0"))
      throw new OrganizationPermissionError("ROLE_SNAPSHOT_MISMATCH", 409, "角色权限或共享成员已变化，请重新申请");
    const batch = randomUUID();
    for (const target of snapshot.targets) {
      const id = await insertDataGrant(db, org, roleId, target, batch, startsAt, expiresAt, "审批通过", "request");
      await db.prepare("UPDATE organization_role_data_grants SET request_id = ? WHERE id = ?").run(requestId, id);
      ids.push(id);
    }
  } else {
    const id = randomUUID();
    await db
      .prepare(
        `INSERT INTO organization_feature_grants (
          id, organization_id, subject_type, subject_id, targets_json, features_json,
          enabled, starts_at, expires_at, reason, request_id, created_at
        ) VALUES (?, ?, 'user', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        org,
        requesterId,
        JSON.stringify(snapshot.targets),
        JSON.stringify(snapshot.features),
        startsAt,
        expiresAt,
        "审批通过",
        requestId,
        startsAt,
      );
    ids.push(id);
  }
  await recordGrantLedger(db, org, { name: "审批" }, kind === "data" ? "生成数据授权" : "生成功能授权", "最终通过、授权与台账同一事务", {
    after: { grantIds: ids, startsAt, expiresAt },
    targets: snapshot.targets,
    requestId,
    grantId: ids[0] ?? null,
  });
  return ids;
}

function snapshotOf(row: RequestRow): PermissionSnapshot {
  return parse(row.permission_snapshot_json, {
    permissionCodes: [],
    holderIds: [],
    targets: [],
    features: null,
    durationMs: null,
  });
}

function nodesOf(row: RequestRow): FlowSnapshotNode[] {
  return parse<{ nodes: FlowSnapshotNode[] }>(row.workflow_snapshot_json, { nodes: [] }).nodes;
}

async function stageState(db: EnvmanDatabase, org: string, row: RequestRow) {
  const nodes = nodesOf(row);
  const stage = Number(row.stage_index);
  const node = nodes[stage];
  const history = parse<Array<{ stageIndex: number; userId?: string; decision: string; superseded?: boolean }>>(row.decisions_json, []);
  const decisions = history.filter((item) => !item.superseded);
  const targets = snapshotOf(row).targets;
  if (!node || row.status !== "pending")
    return {
      node,
      decisions,
      history,
      paused: false,
      approvePaused: false,
      reason: row.block_reason,
      qualified: [] as string[],
      canApprove: [] as string[],
      canReject: [] as string[],
      passIds: [] as string[],
    };
  const capabilities = human.has(node.mode) ? await approverCapabilities(db, org, node.resolvedApproverIds, targets) : null;
  const qualified = capabilities ? node.resolvedApproverIds.filter((id) => capabilities.has(id)) : node.resolvedApproverIds;
  const canApprove = node.resolvedApproverIds.filter((id) => capabilities?.get(id)?.approve);
  const canReject = node.resolvedApproverIds.filter((id) => capabilities?.get(id)?.reject);
  const approved = new Set(
    decisions.filter((item) => item.stageIndex === stage && item.decision === "approve").map((item) => item.userId),
  );
  // Snapshot pass ids stay required. Losing approve while keeping reject is not a pass, and the id is not removed.
  const passIds = node.passApproverIds ?? node.resolvedApproverIds;
  const lost = node.resolvedApproverIds.filter((id) => !qualified.includes(id) && !approved.has(id));
  const paused = (node.mode === "all" || node.mode === "sequence") && lost.length > 0;
  const approvePaused =
    (node.mode === "all" || node.mode === "sequence") &&
    passIds.some((id) => !canApprove.includes(id) && !approved.has(id));
  return {
    node,
    decisions,
    history,
    paused,
    approvePaused,
    qualified,
    canApprove,
    canReject,
    passIds,
    reason: paused || approvePaused ? "会签或依次审批中有审批人失去资格，流程暂停" : row.block_reason,
  };
}

export async function listGrantRequests(
  db: EnvmanDatabase,
  org: string,
  viewerId: string,
  view: "mine" | "todo" | "all",
) {
  const rows = await db
    .prepare(
      "SELECT * FROM organization_grant_requests WHERE organization_id = ? ORDER BY created_at DESC, id DESC",
    )
    .all<RequestRow>(org);
  const items = [];
  for (const row of rows) {
    const state = await stageState(db, org, row);
    const mine = row.requester_id === viewerId;
    const todo = row.status === "pending" && !state.paused && state.qualified.includes(viewerId) && state.node?.mode !== "sequence"
      ? true
      : row.status === "pending" && !state.paused && state.node?.mode === "sequence" && state.qualified.find((id) => !state.decisions.some((item) => item.stageIndex === Number(row.stage_index) && item.userId === id)) === viewerId;
    if (view === "mine" && !mine) continue;
    if (view === "todo" && !todo) continue;
    items.push(await presentRequest(db, org, row, viewerId, state, todo));
  }
  return { items };
}

async function presentRequest(
  db: EnvmanDatabase,
  _org: string,
  row: RequestRow,
  viewerId: string,
  state: Awaited<ReturnType<typeof stageState>>,
  todo: boolean,
) {
  const snapshot = snapshotOf(row);
  const names = await db
    .prepare("SELECT id, username FROM admin_users WHERE id = ?")
    .get<{ id: string; username: string }>(row.requester_id);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    blockReason: state.reason || "",
    requesterId: row.requester_id,
    requesterName: names?.username ?? "",
    roleId: row.kind === "data" ? row.role_id : null,
    features: row.kind === "feature" ? snapshot.features : null,
    targets: snapshot.targets,
    permissionCodes: snapshot.permissionCodes,
    holderIds: snapshot.holderIds,
    durationMs: snapshot.durationMs,
    stageIndex: Number(row.stage_index),
    nodes: nodesOf(row).map(({ resolvedApproverIds, name, mode, allowSelf }) => ({
      name,
      mode,
      allowSelf,
      approverIds: resolvedApproverIds,
    })),
    decisions: state.history,
    grantIds: parse<string[]>(row.grant_ids_json, []),
    canDecide: todo && viewerId !== "",
    canApprove: todo && state.canApprove.includes(viewerId),
    canReject: todo && state.canReject.includes(viewerId),
    canWithdraw: row.status === "pending" && row.requester_id === viewerId,
    version: Number(row.version),
  };
}

export async function readGrantRequest(db: EnvmanDatabase, org: string, requestId: string, viewerId: string, canViewAll: boolean) {
  const row = await db
    .prepare("SELECT * FROM organization_grant_requests WHERE organization_id = ? AND id = ?")
    .get<RequestRow>(org, requestId);
  if (!row) throw new OrganizationPermissionError("NOT_FOUND", 404, "申请不存在");
  const state = await stageState(db, org, row);
  const todo = row.status === "pending" && state.qualified.includes(viewerId);
  if (row.requester_id !== viewerId && !todo && !canViewAll)
    throw new OrganizationPermissionError("NOT_FOUND", 404, "申请不存在或无权查看");
  return presentRequest(db, org, row, viewerId, state, todo && !state.paused);
}

async function mutateRequest(
  db: EnvmanDatabase,
  org: string,
  requestId: string,
  _actorId: string,
  change: (row: RequestRow) => Promise<{ status: string; stage: number; decisions: unknown[]; grantIds?: string[]; blockReason?: string } | { done: true }>,
) {
  return db.transaction(async () => {
    await db.prepare("UPDATE organizations SET updated_at = updated_at WHERE id = ?").run(org);
    const row = await db
      .prepare("SELECT * FROM organization_grant_requests WHERE organization_id = ? AND id = ?")
      .get<RequestRow>(org, requestId);
    if (!row) throw new OrganizationPermissionError("NOT_FOUND", 404, "申请不存在");
    if (row.status !== "pending")
      return {
        status: row.status,
        grantIds: parse<string[]>(row.grant_ids_json, []),
        already: true,
        blockReason: row.block_reason || "",
      };
    const next = await change(row);
    if ("done" in next) return { status: row.status, grantIds: parse<string[]>(row.grant_ids_json, []), already: true, blockReason: row.block_reason || "" };
    const grantIds = next.grantIds ?? parse<string[]>(row.grant_ids_json, []);
    const changed = await db
      .prepare(
        `UPDATE organization_grant_requests SET status = ?, stage_index = ?, decisions_json = ?, grant_ids_json = ?,
         block_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND version = ?`,
      )
      .run(
        next.status,
        next.stage,
        JSON.stringify(next.decisions),
        JSON.stringify(grantIds),
        next.blockReason ?? "",
        new Date().toISOString(),
        row.id,
        Number(row.version),
      );
    if (!changed.changes)
      throw new OrganizationPermissionError("REQUEST_CHANGED", 409, "申请已被其他操作处理");
    return { status: next.status, grantIds, already: false, blockReason: next.blockReason ?? "" };
  })();
}

export async function decideGrantRequest(
  db: EnvmanDatabase,
  org: string,
  requestId: string,
  actor: LedgerActor,
  decision: "approve" | "reject",
  comment: string,
) {
  const actorId = actor.id ?? "";
  const result = await mutateRequest(db, org, requestId, actorId, async (row) => {
    const state = await stageState(db, org, row);
    if (state.paused)
      throw new OrganizationPermissionError("APPROVAL_PAUSED", 409, state.reason);
    const node = state.node;
    if (!node || !state.qualified.includes(actorId))
      throw new OrganizationPermissionError("APPROVER_REQUIRED", 403, "当前节点没有你的有效审批资格");
    if (decision === "approve" && !state.canApprove.includes(actorId))
      throw new OrganizationPermissionError("APPROVAL_DECISION_FORBIDDEN", 403, "没有当前范围的审批通过权限");
    if (decision === "reject" && !state.canReject.includes(actorId))
      throw new OrganizationPermissionError("APPROVAL_DECISION_FORBIDDEN", 403, "没有当前范围的审批拒绝权限");
    if (decision === "approve" && state.approvePaused)
      throw new OrganizationPermissionError("APPROVAL_PAUSED", 409, state.reason);
    if (node.mode === "sequence") {
      const pending = node.resolvedApproverIds.find(
        (id) => state.qualified.includes(id) && !state.decisions.some((item) => item.stageIndex === Number(row.stage_index) && item.userId === id),
      );
      if (pending !== actorId)
        throw new OrganizationPermissionError("APPROVER_REQUIRED", 403, "还没轮到你审批");
    }
    if (node.requireComment && !comment.trim())
      throw new OrganizationPermissionError("COMMENT_REQUIRED", 400, "这个节点要求填写意见");
    const decisions: Array<{ stageIndex: number; userId?: string; decision: string; superseded?: boolean; comment?: string; at?: string; automatic?: boolean }> = [
      ...state.history,
      { stageIndex: Number(row.stage_index), userId: actorId, decision, comment, at: new Date().toISOString() },
    ];
    if (decision === "reject") return { status: "rejected", stage: Number(row.stage_index), decisions };
    const approvals = decisions.filter((item) => !item.superseded && item.stageIndex === Number(row.stage_index) && item.decision === "approve");
    const approvedBy = (id: string) => approvals.some((item) => item.userId === id);
    const complete =
      node.mode === "any" ||
      ((node.mode === "all" || node.mode === "sequence") &&
        state.passIds.length > 0 &&
        !state.approvePaused &&
        state.passIds.every(approvedBy));
    if (!complete) return { status: "pending", stage: Number(row.stage_index), decisions };
    let stage = Number(row.stage_index) + 1;
    const nodes = nodesOf(row);
    while (stage < nodes.length && !human.has(nodes[stage].mode)) {
      if (nodes[stage].mode === "auto_reject")
        return { status: "rejected", stage, decisions: [...decisions, { stageIndex: stage, decision: "reject", automatic: true }] };
      decisions.push({ stageIndex: stage, decision: nodes[stage].mode === "cc" ? "cc" : "approve", automatic: true });
      stage += 1;
    }
    if (stage < nodes.length) return { status: "pending", stage, decisions };
    const snapshot = snapshotOf(row);
    const catalog = await organizationResourceCatalog(db, org);
    if (snapshot.targets.some((target) => !catalog.some((item) => sameTarget(item, target))))
      throw new OrganizationPermissionError("INVALID_RESOURCE", 409, "申请中的资源已经不存在");
    const member = await db
      .prepare(
        `SELECT 1 FROM organization_members m JOIN admin_users u ON u.id = m.user_id
         WHERE m.organization_id = ? AND m.user_id = ? AND u.status = 'active'`,
      )
      .get(org, row.requester_id);
    if (!member) throw new OrganizationPermissionError("REQUESTER_INACTIVE", 409, "申请人已经不是有效组织成员");
    try {
      const grantIds = await grantApproved(db, org, row.requester_id, row.kind, snapshot, row.id, serverNow(), row.role_id);
      return { status: "approved", stage, decisions, grantIds };
    } catch (error) {
      if (
        error instanceof OrganizationPermissionError &&
        ["ROLE_SNAPSHOT_MISMATCH", "ROLE_NOT_HELD", "ROLE_REQUIRED", "INVALID_RESOURCE", "REQUESTER_INACTIVE"].includes(error.code)
      )
        return {
          status: "pending",
          stage: Number(row.stage_index),
          decisions: state.history,
          blockReason: error.message,
          grantIds: [] as string[],
        };
      throw error;
    }
  });
  if (!result.already) {
    const action = result.status === "approved" ? "审批通过" : result.status === "rejected" ? "审批拒绝" : result.blockReason ? "审批未生效" : "节点通过";
    await recordGrantLedger(db, org, actor, action, comment || decision, {
      requestId,
      after: result,
    });
  }
  return result;
}

export async function withdrawGrantRequest(
  db: EnvmanDatabase,
  org: string,
  requestId: string,
  actor: LedgerActor,
  reason: string,
) {
  const actorId = actor.id ?? "";
  const result = await mutateRequest(db, org, requestId, actorId, async (row) => {
    if (row.requester_id !== actorId)
      throw new OrganizationPermissionError("REQUEST_NOT_WITHDRAWABLE", 403, "只能撤回自己的待审批申请");
    const decisions = parse<unknown[]>(row.decisions_json, []);
    decisions.push({ decision: "withdraw", userId: actor.id, at: new Date().toISOString(), comment: reason });
    return { status: "withdrawn", stage: Number(row.stage_index), decisions };
  });
  if (!result.already)
    await recordGrantLedger(db, org, actor, "撤回授权申请", reason, { requestId, after: result });
  return result;
}

export async function reviseGrantRequest(
  db: EnvmanDatabase,
  org: string,
  requestId: string,
  actor: LedgerActor,
  revision: { type: "transfer" | "add_sign" | "rollback"; userId?: string; stageIndex?: number; comment: string },
) {
  return db.transaction(async () => {
    const row = await db
      .prepare("SELECT * FROM organization_grant_requests WHERE organization_id = ? AND id = ?")
      .get<RequestRow>(org, requestId);
    if (!row || row.status !== "pending")
      throw new OrganizationPermissionError("REQUEST_CLOSED", 409, "只能调整待审批申请");
    const state = await stageState(db, org, row);
    if (!state.node || !actor.id || !state.qualified.includes(actor.id))
      throw new OrganizationPermissionError("APPROVER_REQUIRED", 403, "只有当前有效审批人可以调整节点");
    const workflow = parse<{ flowId: string; flowName: string; nodes: FlowSnapshotNode[] }>(row.workflow_snapshot_json, {
      flowId: "",
      flowName: "",
      nodes: [],
    });
    const before = workflow.nodes.map((node) => ({ ...node }));
    const stage = Number(row.stage_index);
    if (revision.type === "rollback") {
      const target = revision.stageIndex ?? stage - 1;
      if (target < 0 || target > stage)
        throw new OrganizationPermissionError("INVALID_ROLLBACK", 400, "只能回退到当前或更早的节点");
      workflow.nodes.forEach((node, index) => {
        const prior = before[index];
        if (index < target || !prior) return;
        node.resolvedApproverIds = prior.resolvedApproverIds;
        if (prior.passApproverIds) node.passApproverIds = [...prior.passApproverIds];
      });
      const decisions = state.history.map((item) =>
        item.stageIndex >= target && !item.superseded ? { ...item, superseded: true } : item,
      );
      await db
        .prepare(
          "UPDATE organization_grant_requests SET stage_index = ?, decisions_json = ?, workflow_snapshot_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(target, JSON.stringify(decisions), JSON.stringify(workflow), new Date().toISOString(), row.id);
    } else {
      if (!revision.userId) throw new OrganizationPermissionError("APPROVER_REQUIRED", 400, "请选择人员");
      const targets = snapshotOf(row).targets;
      const capabilities = await approverCapabilities(db, org, [revision.userId], targets);
      if (!capabilities.has(revision.userId)) throw new OrganizationPermissionError("APPROVER_REQUIRED", 409, "对象没有当前范围的审批权限");
      const node = workflow.nodes[stage];
      const nextId = revision.userId;
      if (revision.type === "transfer") {
        node.resolvedApproverIds = node.resolvedApproverIds.map((id) => (id === actor.id ? nextId : id));
        if (node.passApproverIds)
          node.passApproverIds = node.passApproverIds.map((id) => (id === actor.id ? nextId : id));
      } else if (!node.resolvedApproverIds.includes(nextId)) {
        node.resolvedApproverIds.push(nextId);
        if (node.passApproverIds && capabilities.get(nextId)?.approve && !node.passApproverIds.includes(nextId))
          node.passApproverIds = [...node.passApproverIds, nextId];
      }
      await db
        .prepare(
          "UPDATE organization_grant_requests SET workflow_snapshot_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(workflow), new Date().toISOString(), row.id);
    }
    await recordGrantLedger(db, org, actor, revision.type === "transfer" ? "转交" : revision.type === "add_sign" ? "加签" : "回退", revision.comment, {
      before,
      after: workflow.nodes,
      requestId,
    });
    return { ok: true };
  })();
}

export async function roleNamesByMember(db: EnvmanDatabase, org: string, now = serverNow()) {
  const state = await roleState(db, org);
  const names = new Map<string, string[]>();
  for (const role of state.roles) {
    if (!role.enabled) continue;
    for (const userId of await roleHolderIds(db, org, role.id, now)) {
      const list = names.get(userId) ?? [];
      list.push(role.name);
      names.set(userId, list);
    }
  }
  return names;
}

export async function listGrantLedger(db: EnvmanDatabase, org: string) {
  const rows = await db
    .prepare(
      "SELECT * FROM organization_grant_ledger WHERE organization_id = ? ORDER BY created_at DESC, id DESC",
    )
    .all<Record<string, unknown>>(org);
  return {
    items: rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      reason: row.reason,
      targets: parse<ResourceRef[]>(row.target_refs_json, []),
      requestId: row.request_id,
      grantId: row.grant_id,
      channel: row.channel,
      createdAt: row.created_at,
    })),
  };
}
