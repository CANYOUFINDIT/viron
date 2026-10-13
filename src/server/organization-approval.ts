import { randomUUID } from "node:crypto";
import type { EnvmanDatabase } from "./database-client.js";
import {
  OrganizationPermissionError,
  insertDataGrant,
  loadOrganizationAccess,
  freezeFeatureTargets,
  organizationResourceCatalog,
  roleState,
} from "./organization-rbac.js";
import { RESOURCE_TYPE_LABELS, resourceKey, validAt, type ResourceCatalogItem, type ResourceRef } from "../shared/organization-rbac.js";
import { serverNow } from "./organization-boundary.js";

export type FlowMode = "any" | "all" | "sequence" | "auto_approve" | "auto_reject" | "cc";
export interface FlowNode {
  id: string;
  name: string;
  mode: string;
  approverUserIds: string[];
  approverRoleId: string | null;
  allowSelf: boolean;
  requireComment: boolean;
  /**
   * 缺省表示沿用原先“当前审批人可以操作”。只有明确 false 才关闭。
   * 新保存的流程会写成明确布尔值；已提交申请仍读自己的快照。
   */
  allowTransfer?: boolean;
  allowAddSign?: boolean;
  allowRollback?: boolean;
  /** Set when an imported legacy node must stay untouched and cannot execute. */
  unsupported?: boolean;
  legacySnapshot?: unknown;
}
export interface FlowSnapshotNode extends FlowNode {
  resolvedApproverIds: string[];
  /** Members who held approval.approve for these targets when the request was submitted. */
  passApproverIds: string[];
  resolution: string;
  /** Usernames frozen when these members entered the request snapshot. */
  approverNames?: Record<string, string>;
  /** Role name frozen at submit. Absent on older snapshots and never filled in later. */
  approverRoleName?: string | null;
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
const supportedModes = new Set<string>(["any", "all", "sequence", "auto_approve", "auto_reject", "cc"]);
const human = new Set<string>(["any", "all", "sequence"]);

function unsupportedNode(node: { mode?: string; unsupported?: boolean }) {
  return node.unsupported === true || !supportedModes.has(String(node.mode ?? ""));
}

function unsupportedNodeMessage(node: { name?: string; mode?: string }, action: "编辑" | "提交" | "审批") {
  const name = node.name?.trim() || "未命名节点";
  const mode = node.mode || "未识别";
  return action === "编辑"
    ? `流程包含不支持的旧节点“${name}”（${mode}），已保留原配置，不能编辑或降级为任一人审批`
    : `节点“${name}”使用不支持的旧模式“${mode}”，已保留原配置，不能${action}`;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) if (typeof item === "string" && item && !ids.includes(item)) ids.push(item);
  return ids;
}

type NodeOperation = "transfer" | "add_sign" | "rollback";

function assignStoredFlag(node: FlowNode, key: "allowTransfer" | "allowAddSign" | "allowRollback", value: unknown) {
  if (value === true || value === false) node[key] = value;
}

/** Missing stays allowed. An explicit false is the only stored off switch. */
function nodeAllows(node: FlowNode | undefined, operation: NodeOperation) {
  if (!node) return false;
  const value = operation === "transfer" ? node.allowTransfer : operation === "add_sign" ? node.allowAddSign : node.allowRollback;
  return value !== false;
}

function storedSwitches(node: FlowNode): FlowNode {
  return {
    ...node,
    allowTransfer: node.allowTransfer !== false,
    allowAddSign: node.allowAddSign !== false,
    allowRollback: node.allowRollback !== false,
  };
}

/** Maps one old workflow document. Unknown modes stay intact and are marked unsupported. */
function legacyNodesFromWorkflow(raw: string): FlowNode[] {
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const stages = Array.isArray(record?.stages) ? record.stages : Array.isArray(record?.nodes) ? record.nodes : null;
  if (!stages?.length) {
    return [{
      id: randomUUID(),
      name: "未识别的旧流程",
      mode: "unrecognized",
      approverUserIds: [],
      approverRoleId: null,
      allowSelf: false,
      requireComment: false,
      unsupported: true,
      legacySnapshot: parsed,
    }];
  }
  return stages.map((stage, index) => {
    const item = stage && typeof stage === "object" ? (stage as Record<string, unknown>) : {};
    const mode = typeof item.mode === "string" && item.mode ? item.mode : "unrecognized";
    const role = item.approverRoleId ?? item.roleId;
    const node: FlowNode = {
      id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `审批节点 ${index + 1}`,
      mode,
      approverUserIds: textList(item.approverUserIds ?? item.approverIds),
      approverRoleId: typeof role === "string" && role ? role : null,
      allowSelf: item.allowSelf === true,
      requireComment: item.requireComment === true,
    };
    assignStoredFlag(node, "allowTransfer", item.allowTransfer);
    assignStoredFlag(node, "allowAddSign", item.allowAddSign);
    assignStoredFlag(node, "allowRollback", item.allowRollback);
    if (!supportedModes.has(mode)) {
      node.unsupported = true;
      node.legacySnapshot = stage;
    }
    return node;
  });
}

type LedgerActor = { id?: string | null; name?: string | null; username?: string | null };

function ledgerActorName(actor: LedgerActor): string {
  return actor.username?.trim() || actor.name?.trim() || "系统";
}

function redactLedger(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLedger);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/password|secret|credential|token|privatekey|ciphertext/i.test(key))
      .map(([key, item]) => [key, redactLedger(item)]),
  );
}

async function resolveLedgerActor(db: EnvmanDatabase, actor: LedgerActor): Promise<LedgerActor> {
  if (!actor.id) return { id: null, username: actor.username ?? null, name: actor.name ?? null };
  const row = await db.prepare("SELECT username FROM admin_users WHERE id = ?").get<{ username: string }>(actor.id);
  const username = row?.username?.trim() || actor.username?.trim() || "";
  return { id: actor.id, username, name: username };
}

/** Records configure-only maintenance for the creator. It is not a role data grant and does not add web.use. */
export async function grantCreatedResourceMaintenance(
  db: EnvmanDatabase,
  org: string,
  actor: LedgerActor,
  code: string,
  environmentId: string,
  target: ResourceRef,
) {
  if (!actor.id) return null;
  const id = randomUUID();
  await db
    .prepare(
      `INSERT INTO organization_resource_maintenance (
        id, organization_id, actor_id, code, target_type, target_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, org, actor.id, code, target.type, target.id, new Date().toISOString());
  await recordGrantLedger(db, org, actor, "建立资源配置", "仅记录创建者对这条资源的配置维护，不加入原角色数据授权", {
    after: { maintenanceId: id, code, environmentId, target },
    targets: [{ type: "environment", id: environmentId }, target],
    channel: "initial",
  });
  return id;
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
  const targets = await stampTargetNames(db, org, details.targets ?? []);
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
      details.before === undefined ? null : JSON.stringify(redactLedger(details.before)),
      details.after === undefined ? null : JSON.stringify(redactLedger(details.after)),
      JSON.stringify(targets),
      details.requestId ?? null,
      details.grantId ?? null,
      details.channel ?? null,
      new Date().toISOString(),
    );
}

async function stampTargetNames(db: EnvmanDatabase, org: string, targets: ResourceRef[]) {
  if (!targets.length) return [];
  const catalog = await organizationResourceCatalog(db, org);
  return targets.map((target) => {
    const name = catalog.find((item) => item.type === target.type && item.id === target.id)?.name;
    return name ? { type: target.type, id: target.id, name } : { type: target.type, id: target.id };
  });
}

const connectionResourceType = {
  ssh: "ssh_connection",
  database: "database_connection",
  redis: "redis_connection",
} as const;

/** Records an organization connection's environment association only when the set actually changes. */
export async function recordConnectionEnvironmentChange(
  db: EnvmanDatabase,
  workspace: { type: string; id: string },
  actor: LedgerActor,
  kind: keyof typeof connectionResourceType,
  connectionId: string,
  connectionName: string,
  beforeEnvironmentIds: string[],
  afterEnvironmentIds: string[],
) {
  if (workspace.type !== "organization") return;
  const beforeIds = [...new Set(beforeEnvironmentIds)].sort();
  const afterIds = [...new Set(afterEnvironmentIds)].sort();
  if (beforeIds.join("\0") === afterIds.join("\0")) return;
  const ids = [...new Set([...beforeIds, ...afterIds])];
  const rows = ids.length
    ? await db.prepare(`SELECT id, name FROM environments WHERE id IN (${ids.map(() => "?").join(",")})`).all<{ id: string; name: string }>(...ids)
    : [];
  const nameOf = (id: string) => rows.find((row) => row.id === id)?.name || "已删除的环境";
  const named = (list: string[]) => list.map((id) => ({ type: "environment" as const, id, name: nameOf(id) }));
  const describe = (list: string[]) => (list.length ? list.map(nameOf).join("、") : "未关联环境");
  await recordGrantLedger(db, workspace.id, actor, "变更资源关联", `关联环境由「${describe(beforeIds)}」改为「${describe(afterIds)}」`, {
    before: {
      target: { type: connectionResourceType[kind], id: connectionId, name: connectionName },
      environmentIds: beforeIds,
      environments: named(beforeIds),
    },
    after: {
      target: { type: connectionResourceType[kind], id: connectionId, name: connectionName },
      environmentIds: afterIds,
      environments: named(afterIds),
    },
    targets: [
      { type: connectionResourceType[kind], id: connectionId },
      ...ids.map((id) => ({ type: "environment" as const, id })),
    ],
    channel: "association",
  });
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
  const role = state.roles.find((item) => item.id === roleId);
  if (!role?.enabled) return [];
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

async function defaultFlowId(db: EnvmanDatabase, org: string) {
  const row = await db
    .prepare(
      "SELECT id FROM organization_approval_flows WHERE organization_id = ? AND is_default = 1 ORDER BY created_at, id",
    )
    .get<{ id: string }>(org);
  return row?.id;
}

export async function ensureDefaultApprovalFlow(db: EnvmanDatabase, org: string) {
  const ready = await defaultFlowId(db, org);
  if (ready) return ready;
  // The flow row and its ledger entry commit together. A ledger failure must not leave the default flow.
  // Concurrent first reads lock the organization row, then take a current read, so they share one default flow.
  return db.transaction(async () => {
    await db.prepare("UPDATE organizations SET updated_at = updated_at WHERE id = ?").run(org);
    const existing = await db
      .prepare(
        `SELECT id FROM organization_approval_flows WHERE organization_id = ? AND is_default = 1 ORDER BY created_at, id${
          db.dialect === "mysql" ? " FOR UPDATE" : ""
        }`,
      )
      .get<{ id: string }>(org);
    if (existing?.id) return existing.id;
    const legacy = await db
      .prepare("SELECT workflow_json FROM organization_approval_workflows WHERE organization_id = ?")
      .get<{ workflow_json: string }>(org);
    let nodes: FlowNode[];
    if (legacy) nodes = legacyNodesFromWorkflow(legacy.workflow_json);
    else {
      const role = await db
        .prepare(
          `SELECT id FROM organization_roles WHERE organization_id = ? AND enabled = 1
           AND permission_codes_json LIKE ? ORDER BY created_at, id LIMIT 1`,
        )
        .get<{ id: string }>(org, '%"approval.approve"%');
      nodes = [{
        id: randomUUID(),
        name: "组织审批",
        mode: "any",
        approverUserIds: [],
        approverRoleId: role?.id ?? null,
        allowSelf: false,
        requireComment: false,
        allowTransfer: true,
        allowAddSign: true,
        allowRollback: true,
      }];
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const inserted = await db
      .prepare(
        `INSERT INTO organization_approval_flows (
          id, organization_id, name, is_default, enabled, nodes_json, created_at, updated_at
        )
        SELECT ?, ?, ?, 1, 1, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM organization_approval_flows WHERE organization_id = ? AND is_default = 1
        )`,
      )
      .run(id, org, "所有连接", JSON.stringify(nodes), now, now, org);
    if (!inserted.changes) {
      const winner = await defaultFlowId(db, org);
      if (!winner) throw new OrganizationPermissionError("DEFAULT_FLOW_REQUIRED", 409, "组织必须保留一条默认审批流程");
      return winner;
    }
    await recordGrantLedger(db, org, { name: "系统" }, "建立默认审批流程", legacy ? "兼容旧审批流程，保留原节点" : "承接未分配的资源", {
      after: { id, name: "所有连接", legacy: Boolean(legacy) },
    });
    return id;
  })();
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
  const named = (target: ResourceRef) => ({
    ...target,
    name: catalog.find((item) => item.type === target.type && item.id === target.id)?.name ?? "",
  });
  const unassigned = catalog
    .filter((target) => !owned.has(resourceKey(target)))
    .map((target) => ({ type: target.type, id: target.id, name: target.name, environmentIds: target.environmentIds }));
  const members = await db
    .prepare(
      `SELECT u.id, u.username, u.status FROM organization_members m
       JOIN admin_users u ON u.id = m.user_id
       WHERE m.organization_id = ? ORDER BY u.username, u.id`,
    )
    .all<{ id: string; username: string; status: string }>(org);
  return {
    items: items.map((item) => ({
      ...item,
      nodes: item.nodes.map((node) => (unsupportedNode(node) ? { ...node, unsupported: true } : node)),
      targets: item.targets.map(named),
      coverage: item.isDefault ? unassigned.length : item.targets.length,
    })),
    catalog: catalog.map((target) => ({ type: target.type, id: target.id, name: target.name, environmentIds: target.environmentIds })),
    unassigned,
    roles: (await roleState(db, org)).roles.map((role) => ({ id: role.id, name: role.name, enabled: role.enabled })),
    members: members.map((member) => ({ id: member.id, username: member.username, status: member.status })),
  };
}

function sameTarget(left: ResourceRef, right: ResourceRef) {
  return left.type === right.type && left.id === right.id;
}

function displayTargets(catalog: ResourceCatalogItem[], targets: ResourceRef[]): FrozenTargetDisplay[] {
  const environments = new Map(catalog.filter((item) => item.type === "environment").map((item) => [item.id, item.name]));
  return targets.map((target) => {
    const item = catalog.find((entry) => sameTarget(entry, target));
    const linked = (item?.environmentIds ?? []).flatMap((id) => {
      const name = environments.get(id)?.trim();
      return name ? [name] : [];
    });
    return {
      type: target.type,
      id: target.id,
      name: item?.name?.trim() ?? "",
      typeName: RESOURCE_TYPE_LABELS[target.type],
      environmentName: target.type === "environment" ? (item?.name?.trim() ?? "") : linked.join("、"),
    };
  });
}

function frozenDisplay(snapshot: PermissionSnapshot): FrozenRequestDisplay | null {
  const display = snapshot.display;
  if (!display || display.frozen !== true || typeof display.requesterName !== "string") return null;
  if (!(display.roleName === null || typeof display.roleName === "string")) return null;
  if (!display.holderNames || typeof display.holderNames !== "object" || Array.isArray(display.holderNames)) return null;
  if (!Array.isArray(display.targets) || display.targets.length !== snapshot.targets.length) return null;
  const holderNames: Record<string, string> = {};
  for (const [id, name] of Object.entries(display.holderNames)) {
    if (typeof name !== "string") return null;
    holderNames[id] = name;
  }
  const targets: FrozenTargetDisplay[] = [];
  for (let index = 0; index < display.targets.length; index += 1) {
    const target = display.targets[index];
    const stored = snapshot.targets[index];
    if (!target || !stored || !sameTarget(target, stored)) return null;
    if (typeof target.name !== "string" || typeof target.typeName !== "string" || typeof target.environmentName !== "string") return null;
    targets.push({
      type: stored.type,
      id: stored.id,
      name: target.name,
      typeName: target.typeName,
      environmentName: target.environmentName,
    });
  }
  return { frozen: true, roleName: display.roleName, requesterName: display.requesterName, holderNames, targets };
}

function namedLedgerTargets(catalog: Array<ResourceRef & { name?: string }>, targets: ResourceRef[]) {
  return targets.map((target) => {
    const name = catalog.find((item) => sameTarget(item, target))?.name?.trim();
    return name ? { type: target.type, id: target.id, name } : { type: target.type, id: target.id };
  });
}

/** Freezes the node configuration that was stored, plus the member and role names at this moment. */
async function freezeLedgerNodes(db: EnvmanDatabase, org: string, nodes: FlowNode[]) {
  const [names, roles] = await Promise.all([
    accountNames(db, nodes.flatMap((node) => node.approverUserIds)),
    roleState(db, org),
  ]);
  const roleName = new Map(roles.roles.map((role) => [role.id, role.name]));
  return nodes.map((node) => {
    const snapshot: Record<string, unknown> = {
      id: node.id,
      name: node.name,
      mode: node.mode,
      approverUserIds: [...node.approverUserIds],
      approverNames: Object.fromEntries(node.approverUserIds.flatMap((id) => (names[id] ? [[id, names[id]]] : []))),
      approverRoleId: node.approverRoleId,
      approverRoleName: node.approverRoleId ? roleName.get(node.approverRoleId)?.trim() || "" : null,
      allowSelf: node.allowSelf === true,
      requireComment: node.requireComment === true,
    };
    if (node.allowTransfer === true || node.allowTransfer === false) snapshot.allowTransfer = node.allowTransfer;
    if (node.allowAddSign === true || node.allowAddSign === false) snapshot.allowAddSign = node.allowAddSign;
    if (node.allowRollback === true || node.allowRollback === false) snapshot.allowRollback = node.allowRollback;
    return snapshot;
  });
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
    const blocked = flow?.nodes.find(unsupportedNode);
    if (blocked)
      throw new OrganizationPermissionError("UNSUPPORTED_APPROVAL_NODE", 409, unsupportedNodeMessage(blocked, "编辑"));
    if (!input.nodes.length || input.nodes.some((node) => unsupportedNode(node)))
      throw new OrganizationPermissionError("INVALID_APPROVAL_NODE", 400, "审批节点必须保留原有模式，不能降级或留空");
    const conflicts = targets.flatMap((target) => {
      const owner = current.find(
        (item) => !item.isDefault && item.id !== flow?.id && item.targets.some((owned) => sameTarget(owned, target)),
      );
      return owner ? [{ target, flowName: owner.name }] : [];
    });
    if (conflicts.length) {
      const conflictItems = conflicts.map((item) => ({
        type: item.target.type,
        id: item.target.id,
        name: catalog.find((resource) => sameTarget(resource, item.target))?.name ?? item.target.id,
        flowName: item.flowName,
      }));
      throw new OrganizationPermissionError(
        "APPROVAL_SCOPE_CONFLICT",
        409,
        `这些资源已经属于其他流程：${conflictItems.map((item) => item.name).join("、")}`,
        { conflicts: conflictItems },
      );
    }
    const now = new Date().toISOString();
    const id = flow?.id ?? randomUUID();
    const nodes = input.nodes.map(storedSwitches);
    if (flow)
      await db
        .prepare(
          "UPDATE organization_approval_flows SET name = ?, nodes_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(input.name, JSON.stringify(nodes), now, id);
    else
      await db
        .prepare(
          `INSERT INTO organization_approval_flows (
            id, organization_id, name, is_default, enabled, nodes_json, created_at, updated_at
          ) VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
        )
        .run(id, org, input.name, JSON.stringify(nodes), now, now);
    if (!flow?.isDefault) {
      await db.prepare("DELETE FROM organization_approval_flow_targets WHERE organization_id = ? AND flow_id = ?").run(org, id);
      for (const target of targets)
        await db
          .prepare(
            "INSERT INTO organization_approval_flow_targets (organization_id, target_type, target_id, flow_id) VALUES (?, ?, ?, ?)",
          )
          .run(org, target.type, target.id, id);
    }
    const frozenNodes = await freezeLedgerNodes(db, org, [...(flow?.nodes ?? []), ...nodes]);
    const previousCount = flow?.nodes.length ?? 0;
    await recordGrantLedger(db, org, actor, flow ? "修改审批流程" : "新增审批流程", "审批范围与保存同一事务", {
      before: flow
        ? { ...flow, nodes: frozenNodes.slice(0, previousCount), targets: namedLedgerTargets(catalog, flow.targets) }
        : null,
      after: {
        id,
        name: input.name,
        nodes: frozenNodes.slice(previousCount),
        targets: namedLedgerTargets(catalog, flow?.isDefault ? flow.targets : targets),
      },
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
  let approverRoleName: string | null = null;
  if (node.approverRoleId) {
    const holders = await roleHolderIds(db, org, node.approverRoleId);
    ids = [...new Set([...ids, ...holders])];
    const role = await db.prepare("SELECT name FROM organization_roles WHERE organization_id = ? AND id = ?").get<{ name: string | null }>(org, node.approverRoleId);
    approverRoleName = role?.name?.trim() || null;
    const basis = approverRoleName ? `角色 ${approverRoleName}` : "角色成员";
    resolution = resolution ? `${resolution}；${basis}` : basis;
  }
  if (!node.allowSelf) ids = ids.filter((id) => id !== requesterId);
  const capabilities = human.has(node.mode) ? await approverCapabilities(db, org, ids, targets) : null;
  const resolved = capabilities ? ids.filter((id) => capabilities.has(id)) : ids;
  const passApproverIds = capabilities ? resolved.filter((id) => capabilities.get(id)?.approve) : [];
  if (human.has(node.mode) && !resolved.length)
    throw new OrganizationPermissionError("APPROVER_UNAVAILABLE", 409, `节点“${node.name}”没有可审批的人，不能提交`);
  return {
    ...node,
    resolvedApproverIds: resolved,
    passApproverIds,
    resolution: resolution || node.mode,
    approverNames: await accountNames(db, resolved),
    approverRoleName,
  };
}

async function accountNames(db: EnvmanDatabase, userIds: string[]) {
  const names: Record<string, string> = {};
  for (const userId of [...new Set(userIds)]) {
    const row = await db.prepare("SELECT username FROM admin_users WHERE id = ?").get<{ username: string | null }>(userId);
    const name = row?.username?.trim();
    if (name) names[userId] = name;
  }
  return names;
}

interface FrozenTargetDisplay {
  type: ResourceRef["type"];
  id: string;
  name: string;
  typeName: string;
  environmentName: string;
}
interface FrozenRequestDisplay {
  frozen: true;
  roleName: string | null;
  requesterName: string;
  holderNames: Record<string, string>;
  targets: FrozenTargetDisplay[];
}
interface PermissionSnapshot {
  permissionCodes: string[];
  holderIds: string[];
  targets: ResourceRef[];
  features: FeatureGrantFeatures | null;
  durationMs: number | null;
  /** Names saved at submit. Old rows omit this and must not be backfilled with invented history. */
  display?: FrozenRequestDisplay;
}
interface DecisionEvent {
  stageIndex?: number;
  userId?: string;
  decision: string;
  superseded?: boolean;
  comment?: string;
  at?: string;
  automatic?: boolean;
  actorName?: string;
  nameSource?: "snapshot" | "ledger" | "current";
  recipients?: Array<{ id: string; name: string; nameSource: "snapshot" | "current" }>;
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
    /** 按某一返回分组提交时指定 groups[].flowId。缺省才是初次选择。 */
    flowId?: string;
  },
) {
  const now = serverNow();
  const access = await loadOrganizationAccess(db, org, requesterId, now);
  if (!access.allows("authorization.request"))
    throw new OrganizationPermissionError("ACTION_FORBIDDEN", 403, "没有申请授权的权限");
  const catalog = access.catalog;
  const requested = [...new Map(input.targets.map((target) => [resourceKey(target), target])).values()];
  if (!requested.length || requested.some((target) => !catalog.some((item) => sameTarget(item, target))))
    throw new OrganizationPermissionError("INVALID_RESOURCE", 400, "申请目标不存在");
  // 初次功能申请若目标都是环境，冻结当时关联资源。分组提交带 flowId，保存该组清单，不再按“是否全是环境”猜测。
  const targets = !input.flowId && input.kind === "feature" && requested.every((target) => target.type === "environment")
    ? freezeFeatureTargets(catalog, requested)
    : requested;
  if (input.kind === "data") {
    if (!input.roleId) throw new OrganizationPermissionError("ROLE_REQUIRED", 400, "数据申请必须选择已经持有的角色");
    const role = access.state.roles.find((item) => item.id === input.roleId);
    if (role && !role.enabled)
      throw new OrganizationPermissionError("ROLE_DISABLED", 409, "角色已停用，不能作为申请或审批角色");
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
  if (input.flowId) {
    const selected = all.find((item) => item.id === input.flowId);
    if (!selected) throw new OrganizationPermissionError("NOT_FOUND", 404, "审批流程不存在");
    const foreign = targets.filter((target) => flowFor(all, target).id !== selected.id);
    if (foreign.length)
      throw new OrganizationPermissionError("APPROVAL_FLOW_MISMATCH", 409, "这些资源不属于所指定的审批流程", {
        flowId: selected.id,
        targets: foreign,
      });
  }
  const grouped = new Map<string, ResourceRef[]>();
  for (const target of targets) {
    const flow = flowFor(all, target);
    grouped.set(flow.id, [...(grouped.get(flow.id) ?? []), target]);
  }
  if (grouped.size > 1) {
    const groups = [...grouped.entries()].map(([flowId, groupTargets]) => {
      const item = all.find((flow) => flow.id === flowId)!;
      return { flowId, flowName: item.name, targets: groupTargets };
    });
    throw new OrganizationPermissionError(
      "MULTIPLE_APPROVAL_FLOWS",
      409,
      `这些资源分属不同审批流程（${groups.map((group) => group.flowName).join("、")}），请按分组分别提交`,
      { groups },
    );
  }
  const flow = all.find((item) => item.id === [...grouped.keys()][0])!;
  const blocked = flow.nodes.find(unsupportedNode);
  if (blocked)
    throw new OrganizationPermissionError("UNSUPPORTED_APPROVAL_NODE", 409, unsupportedNodeMessage(blocked, "提交"));
  const snapshotNodes: FlowSnapshotNode[] = [];
  for (const node of flow.nodes)
    snapshotNodes.push(await resolveNode(db, org, node, requesterId, targets));
  const role = input.roleId ? access.state.roles.find((item) => item.id === input.roleId) : undefined;
  const holderIds = input.roleId ? await roleHolderIds(db, org, input.roleId, now) : [requesterId];
  const [holderNames, requesterNames] = await Promise.all([
    accountNames(db, holderIds),
    accountNames(db, [requesterId]),
  ]);
  const permissionSnapshot: PermissionSnapshot = {
    permissionCodes: [...(role?.permissionCodes ?? [])].sort(),
    holderIds,
    targets,
    features,
    durationMs: input.durationMs,
    display: {
      frozen: true,
      roleName: role?.name ?? null,
      requesterName: requesterNames[requesterId] ?? "",
      holderNames,
      targets: displayTargets(catalog, targets),
    },
  };
  const id = randomUUID();
  const created = new Date(now).toISOString();
  let status = "pending";
  let stage = 0;
  const decisions: Array<Record<string, unknown>> = [];
  while (stage < snapshotNodes.length && !human.has(snapshotNodes[stage].mode)) {
    const node = snapshotNodes[stage];
    if (unsupportedNode(node))
      throw new OrganizationPermissionError("UNSUPPORTED_APPROVAL_NODE", 409, unsupportedNodeMessage(node, "提交"));
    if (node.mode === "auto_reject") {
      status = "rejected";
      decisions.push({ stageIndex: stage, decision: "reject", at: created, automatic: true, actorName: "系统", nameSource: "snapshot" });
      break;
    }
    decisions.push({ stageIndex: stage, decision: node.mode === "cc" ? "cc" : "approve", at: created, automatic: true, actorName: "系统", nameSource: "snapshot" });
    stage += 1;
    if (node.mode === "auto_approve" && stage >= snapshotNodes.length) status = "approved";
  }
  return db.transaction(async () => {
    const actor = await resolveLedgerActor(db, { id: requesterId });
    const grantIds = status === "approved"
      ? await grantApproved(db, org, requesterId, input.kind, permissionSnapshot, id, now, input.roleId ?? null, actor, input.reason)
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
    await recordGrantLedger(db, org, actor, "提交授权申请", input.reason, {
      before: { status: null },
      after: { id, kind: input.kind, status, source: "request" },
      targets,
      requestId: id,
      grantId: grantIds[0] ?? null,
      channel: "request",
    });
    return { id, status, grantIds };
  })();
}

/** Read-only grant conditions. Requester membership stays a final check in decide, and this does not write grants. */
async function grantBusinessBlock(
  db: EnvmanDatabase,
  org: string,
  requesterId: string,
  kind: "data" | "feature",
  snapshot: PermissionSnapshot,
  roleId: string | null,
  now: number,
) {
  const member = await activeMember(db, org, requesterId);
  if (!member) return { code: "REQUESTER_INACTIVE" as const, message: "申请人已经不是有效组织成员" };
  const catalog = await organizationResourceCatalog(db, org);
  if (snapshot.targets.some((target) => !catalog.some((item) => sameTarget(item, target))))
    return { code: "INVALID_RESOURCE" as const, message: "申请中的资源已经不存在" };
  if (kind !== "data") return null;
  if (!roleId) return { code: "ROLE_REQUIRED" as const, message: "数据申请缺少角色" };
  const holders = await roleHolderIds(db, org, roleId, now);
  const role = (await roleState(db, org)).roles.find((item) => item.id === roleId);
  if (!role?.enabled || !holders.includes(requesterId))
    return { code: "ROLE_NOT_HELD" as const, message: "申请人已经不再持有该角色，不能授予" };
  if ([...role.permissionCodes].sort().join("\0") !== snapshot.permissionCodes.join("\0") || holders.join("\0") !== snapshot.holderIds.join("\0"))
    return { code: "ROLE_SNAPSHOT_MISMATCH" as const, message: "角色权限或共享成员已变化，请重新申请" };
  return null;
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
  actor: LedgerActor,
  reason: string,
) {
  const block = await grantBusinessBlock(db, org, requesterId, kind, snapshot, roleId, now);
  if (block) throw new OrganizationPermissionError(block.code, 409, block.message);
  const startsAt = new Date(now).toISOString();
  const expiresAt = snapshot.durationMs === null ? null : new Date(now + snapshot.durationMs).toISOString();
  const ids: string[] = [];
  let batch: string | null = null;
  if (kind === "data") {
    if (!roleId) throw new OrganizationPermissionError("ROLE_REQUIRED", 409, "数据申请缺少角色");
    batch = randomUUID();
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
  await recordGrantLedger(db, org, actor, kind === "data" ? "生成数据授权" : "生成功能授权", reason, {
    before: { status: "pending", requestId },
    after: { status: "approved", grantIds: ids, startsAt, expiresAt, source: "request", batch: kind === "data" ? batch : null },
    targets: snapshot.targets,
    requestId,
    grantId: ids[0] ?? null,
    channel: "request",
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

function flowOf(row: RequestRow) {
  return parse<{ flowId: string; flowName: string }>(row.workflow_snapshot_json, { flowId: "", flowName: "" });
}

async function stageState(db: EnvmanDatabase, org: string, row: RequestRow) {
  const nodes = nodesOf(row);
  const stage = Number(row.stage_index);
  const node = nodes[stage];
  const history = parse<DecisionEvent[]>(row.decisions_json, []);
  const decisions = history.filter((item) => !item.superseded);
  const targets = snapshotOf(row).targets;
  if (!node || row.status !== "pending")
    return {
      node,
      decisions,
      history,
      paused: false,
      approvePaused: false,
      businessBlock: "",
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
  const business = await grantBusinessBlock(db, org, row.requester_id, row.kind, snapshotOf(row), row.role_id, serverNow());
  return {
    node,
    decisions,
    history,
    paused,
    approvePaused,
    businessBlock: business?.message ?? "",
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
  const selectorCache = new Map<string, Promise<RevisionCandidate[]>>();
  const access = view === "all" ? await loadOrganizationAccess(db, org, viewerId) : null;
  const orgWideView = access?.allows("approval.view") ?? false;
  if (view === "all" && access && !orgWideView && !access.catalog.some((item) => access.allows("approval.view", item)))
    throw new OrganizationPermissionError("ACTION_FORBIDDEN", 403, "没有查看全部申请的权限");
  const items = [];
  for (const row of rows) {
    const state = await stageState(db, org, row);
    const mine = row.requester_id === viewerId;
    const todo = row.status === "pending" && !state.paused && state.qualified.includes(viewerId) && state.node?.mode !== "sequence"
      ? true
      : row.status === "pending" && !state.paused && state.node?.mode === "sequence" && state.qualified.find((id) => !state.decisions.some((item) => item.stageIndex === Number(row.stage_index) && item.userId === id)) === viewerId;
    if (view === "mine" && !mine) continue;
    if (view === "todo" && !todo) continue;
    if (view === "all" && !orgWideView) {
      const targets = snapshotOf(row).targets;
      const covered = targets.length > 0 && targets.every((target) => access?.allows("approval.view", target));
      if (!mine && !covered) continue;
    }
    items.push(await presentRequest(db, org, row, viewerId, state, todo, selectorCache));
  }
  return { items };
}

interface RevisionCandidate {
  userId: string;
  name: string;
  canApprove: boolean;
  canReject: boolean;
}

async function loadRevisionCandidates(db: EnvmanDatabase, org: string, targets: ResourceRef[]): Promise<RevisionCandidate[]> {
  const members = await db
    .prepare(
      `SELECT u.id, u.username FROM organization_members m JOIN admin_users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND u.status = 'active' ORDER BY u.username, u.id`,
    )
    .all<{ id: string; username: string }>(org);
  const unique = [...new Map(members.map((member) => [member.id, member])).values()];
  const capabilities = await approverCapabilities(db, org, unique.map((member) => member.id), targets);
  return unique.flatMap((member) => {
    const capability = capabilities.get(member.id);
    if (!capability) return [];
    const name = member.username?.trim();
    if (!name) return [];
    return [{ userId: member.id, name, canApprove: capability.approve, canReject: capability.reject }];
  });
}

async function revisionCandidates(
  db: EnvmanDatabase,
  org: string,
  targets: ResourceRef[],
  cache: Map<string, Promise<RevisionCandidate[]>>,
) {
  const key = targets.map((target) => resourceKey(target)).sort().join("\n");
  const cached = cache.get(key);
  if (cached) return cached;
  const loading = loadRevisionCandidates(db, org, targets);
  cache.set(key, loading);
  return loading;
}

interface RequestLedgerRow {
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  reason: string | null;
  created_at: string;
}

async function requestLedger(db: EnvmanDatabase, org: string, requestId: string) {
  return db
    .prepare(
      `SELECT actor_id, actor_name, action, reason, created_at FROM organization_grant_ledger
       WHERE organization_id = ? AND request_id = ? ORDER BY created_at, id`,
    )
    .all<RequestLedgerRow>(org, requestId);
}

async function shownRequestNames(db: EnvmanDatabase, org: string, row: RequestRow, snapshot: PermissionSnapshot) {
  const frozen = frozenDisplay(snapshot);
  if (frozen) {
    return {
      namesFrozen: true,
      nameSource: "snapshot" as const,
      roleName: frozen.roleName,
      requesterName: frozen.requesterName,
      holderNames: frozen.holderNames,
      targets: frozen.targets,
    };
  }
  const [catalog, roles, holderNames, requesterNames] = await Promise.all([
    organizationResourceCatalog(db, org),
    row.role_id ? roleState(db, org) : Promise.resolve(null),
    accountNames(db, snapshot.holderIds),
    accountNames(db, [row.requester_id]),
  ]);
  return {
    namesFrozen: false,
    nameSource: "current" as const,
    roleName: roles?.roles.find((item) => item.id === row.role_id)?.name ?? null,
    requesterName: requesterNames[row.requester_id] ?? "",
    holderNames,
    targets: displayTargets(catalog, snapshot.targets),
  };
}

function presentDecisions(
  history: DecisionEvent[],
  nodes: FlowSnapshotNode[],
  ledger: RequestLedgerRow[],
  currentNames: Record<string, string>,
) {
  const used = new Set<number>();
  return history.map((item) => {
    const comment = typeof item.comment === "string" ? item.comment : "";
    const at = typeof item.at === "string" ? item.at : "";
    let actorName = item.actorName?.trim() ?? "";
    let nameSource: DecisionEvent["nameSource"] = actorName ? (item.nameSource === "current" || item.nameSource === "ledger" ? item.nameSource : "snapshot") : "ledger";
    if (!actorName && item.userId && !item.automatic) {
      const index = ledger.findIndex((row, position) => !used.has(position) && row.actor_id === item.userId && String(row.reason ?? "") === comment);
      if (index >= 0) {
        used.add(index);
        actorName = String(ledger[index]?.actor_name ?? "").trim();
      }
    }
    if (!actorName && item.automatic) {
      actorName = "系统";
      nameSource = "snapshot";
    } else if (!actorName) {
      actorName = item.userId ? (currentNames[item.userId] ?? "") : "";
      nameSource = "current";
    }
    const node = typeof item.stageIndex === "number" ? nodes[item.stageIndex] : undefined;
    const recipients = item.decision === "cc" && node
      ? node.resolvedApproverIds.map((id) => {
          const frozenName = node.approverNames?.[id];
          return frozenName
            ? { id, name: frozenName, nameSource: "snapshot" as const }
            : { id, name: currentNames[id] ?? "", nameSource: "current" as const };
        })
      : undefined;
    return { ...item, actorName, comment, at, nameSource, ...(recipients ? { recipients } : {}) };
  });
}

async function presentRequest(
  db: EnvmanDatabase,
  org: string,
  row: RequestRow,
  viewerId: string,
  state: Awaited<ReturnType<typeof stageState>>,
  todo: boolean,
  selectorCache: Map<string, Promise<RevisionCandidate[]>>,
) {
  const snapshot = snapshotOf(row);
  const shown = await shownRequestNames(db, org, row, snapshot);
  const nodes = nodesOf(row);
  const stageIndex = Number(row.stage_index);
  const current = row.status === "pending" ? state.node : undefined;
  const viewerOperates = Boolean(current && viewerId && state.qualified.includes(viewerId));
  const canTransfer = viewerOperates && nodeAllows(current, "transfer");
  const canAddSign = viewerOperates && nodeAllows(current, "add_sign");
  const canRollback = viewerOperates && nodeAllows(current, "rollback") && stageIndex > 0;
  const approverIds = nodes.flatMap((node) => node.resolvedApproverIds);
  const ledger = await requestLedger(db, org, row.id);
  const nameIds = [
    ...approverIds.filter((id) => nodes.some((node) => node.resolvedApproverIds.includes(id) && !node.approverNames?.[id])),
    ...state.history.flatMap((item) => (item.userId && !item.actorName ? [item.userId] : [])),
    ...ledger.flatMap((item) => (item.actor_id && !String(item.actor_name ?? "").trim() ? [item.actor_id] : [])),
  ];
  const [capabilities, liveNames] = await Promise.all([
    approverCapabilities(db, org, approverIds, snapshot.targets),
    accountNames(db, nameIds),
  ]);
  const live = new Map(Object.entries(liveNames));
  const flowPaused = state.paused || state.approvePaused;
  const pauseReason = [flowPaused ? state.reason : "", state.businessBlock].filter(Boolean).join("；");
  const approvalBlocked = flowPaused || Boolean(state.businessBlock);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    flowId: flowOf(row).flowId,
    flowName: flowOf(row).flowName,
    paused: approvalBlocked,
    pauseReason,
    blockReason: pauseReason || state.reason || "",
    requesterId: row.requester_id,
    requesterName: shown.requesterName,
    namesFrozen: shown.namesFrozen,
    nameSource: shown.nameSource,
    roleId: row.kind === "data" ? row.role_id : null,
    roleName: row.kind === "data" ? shown.roleName : null,
    features: row.kind === "feature" ? snapshot.features : null,
    targets: shown.targets,
    permissionCodes: snapshot.permissionCodes,
    holderIds: snapshot.holderIds,
    holderNames: shown.holderNames,
    durationMs: snapshot.durationMs,
    stageIndex,
    requireComment: current?.requireComment === true,
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      mode: node.mode,
      resolution: node.resolution || "",
      allowSelf: node.allowSelf === true,
      requireComment: node.requireComment === true,
      allowTransfer: node.allowTransfer !== false,
      allowAddSign: node.allowAddSign !== false,
      allowRollback: node.allowRollback !== false,
      approverRoleId: node.approverRoleId,
      approverRoleName: typeof node.approverRoleName === "string" && node.approverRoleName.trim() ? node.approverRoleName : null,
      approverIds: node.resolvedApproverIds,
      approvers: node.resolvedApproverIds.map((id) => {
        const capability = capabilities.get(id);
        const frozenName = node.approverNames?.[id];
        return {
          id,
          name: frozenName || live.get(id) || "",
          nameSource: frozenName ? "snapshot" : "current",
          canApprove: capability?.approve === true,
          canReject: capability?.reject === true,
        };
      }),
    })),
    decisions: presentDecisions(state.history, nodes, ledger, liveNames),
    operations: ledger.map((item) => {
      const actorName = String(item.actor_name ?? "").trim();
      const actorId = item.actor_id ?? "";
      return {
        actorId,
        actorName: actorName || (actorId ? liveNames[actorId] ?? "" : ""),
        action: item.action,
        comment: item.reason ?? "",
        at: item.created_at,
        nameSource: actorName ? "ledger" : "current",
      };
    }),
    grantIds: parse<string[]>(row.grant_ids_json, []),
    canDecide: todo && viewerId !== "",
    canApprove: todo && !approvalBlocked && state.canApprove.includes(viewerId),
    canReject: todo && state.canReject.includes(viewerId),
    canTransfer,
    canAddSign,
    canRollback,
    rollbackTargets: canRollback
      ? nodes.slice(0, stageIndex).map((node, index) => ({ stageIndex: index, id: node.id, name: node.name, mode: node.mode }))
      : [],
    revisionCandidates: (canTransfer || canAddSign ? await revisionCandidates(db, org, snapshot.targets, selectorCache) : [])
      .filter((candidate) => current?.allowSelf === true || candidate.userId !== row.requester_id),
    canWithdraw: row.status === "pending" && row.requester_id === viewerId,
    version: Number(row.version),
  };
}

async function requestParticipant(db: EnvmanDatabase, org: string, row: RequestRow, viewerId: string) {
  const member = await activeMember(db, org, viewerId);
  if (!member) return false;
  const nodes = nodesOf(row);
  if (nodes.some((node) => node.resolvedApproverIds.includes(viewerId) || (node.passApproverIds ?? []).includes(viewerId)))
    return true;
  const history = parse<DecisionEvent[]>(row.decisions_json, []);
  if (history.some((item) => item.userId === viewerId)) return true;
  const ledger = await db
    .prepare("SELECT 1 AS ok FROM organization_grant_ledger WHERE organization_id = ? AND request_id = ? AND actor_id = ? LIMIT 1")
    .get<{ ok: number }>(org, row.id, viewerId);
  return Boolean(ledger);
}

export async function readGrantRequest(db: EnvmanDatabase, org: string, requestId: string, viewerId: string) {
  const row = await db
    .prepare("SELECT * FROM organization_grant_requests WHERE organization_id = ? AND id = ?")
    .get<RequestRow>(org, requestId);
  if (!row) throw new OrganizationPermissionError("NOT_FOUND", 404, "申请不存在");
  const state = await stageState(db, org, row);
  const todo = row.status === "pending" && state.qualified.includes(viewerId);
  const access = await loadOrganizationAccess(db, org, viewerId);
  const targets = snapshotOf(row).targets;
  const covered = access.allows("approval.view") || (targets.length > 0 && targets.every((target) => access.allows("approval.view", target)));
  if (row.requester_id !== viewerId && !todo && !covered && !(await requestParticipant(db, org, row, viewerId)))
    throw new OrganizationPermissionError("NOT_FOUND", 404, "申请不存在或无权查看");
  return presentRequest(db, org, row, viewerId, state, todo && !state.paused, new Map());
}

async function activeMember(db: EnvmanDatabase, org: string, userId: string) {
  return db
    .prepare(
      `SELECT u.id, u.username FROM organization_members m JOIN admin_users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND m.user_id = ? AND u.status = 'active'`,
    )
    .get<{ id: string; username: string }>(org, userId);
}

async function assertClosedDecision(db: EnvmanDatabase, org: string, row: RequestRow, actorId: string, decision: "approve" | "reject") {
  const member = await activeMember(db, org, actorId);
  const nodes = nodesOf(row).filter((node) => human.has(node.mode) && node.resolvedApproverIds.includes(actorId));
  if (!member || !nodes.length)
    throw new OrganizationPermissionError("APPROVER_REQUIRED", 403, "当前节点没有你的有效审批资格");
  const access = await loadOrganizationAccess(db, org, actorId);
  const allowed = decision === "approve"
    ? coversApproval(access, "approval.approve", snapshotOf(row).targets)
    : coversApproval(access, "approval.reject", snapshotOf(row).targets);
  if (!allowed)
    throw new OrganizationPermissionError("APPROVAL_DECISION_FORBIDDEN", 403, decision === "approve" ? "没有当前范围的审批通过权限" : "没有当前范围的审批拒绝权限");
}

async function assertClosedWithdraw(db: EnvmanDatabase, org: string, row: RequestRow, actorId: string) {
  const member = await activeMember(db, org, actorId);
  if (!member || row.requester_id !== actorId)
    throw new OrganizationPermissionError("REQUEST_NOT_WITHDRAWABLE", 403, "只能撤回自己的待审批申请");
}

async function mutateRequest(
  db: EnvmanDatabase,
  org: string,
  requestId: string,
  onClosed: (row: RequestRow) => Promise<void>,
  change: (row: RequestRow) => Promise<{ status: string; stage: number; decisions: unknown[]; grantIds?: string[]; blockReason?: string } | { done: true }>,
  record: (row: RequestRow, outcome: { status: string; grantIds: string[]; blockReason: string }) => Promise<void>,
) {
  return db.transaction(async () => {
    await db.prepare("UPDATE organizations SET updated_at = updated_at WHERE id = ?").run(org);
    const row = await db
      .prepare("SELECT * FROM organization_grant_requests WHERE organization_id = ? AND id = ?")
      .get<RequestRow>(org, requestId);
    if (!row) throw new OrganizationPermissionError("NOT_FOUND", 404, "申请不存在");
    if (row.status !== "pending") {
      await onClosed(row);
      return {
        status: row.status,
        grantIds: parse<string[]>(row.grant_ids_json, []),
        already: true,
        blockReason: row.block_reason || "",
      };
    }
    const next = await change(row);
    if ("done" in next) {
      await onClosed(row);
      return { status: row.status, grantIds: parse<string[]>(row.grant_ids_json, []), already: true, blockReason: row.block_reason || "" };
    }
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
    const outcome = { status: next.status, grantIds, already: false, blockReason: next.blockReason ?? "" };
    await record(row, outcome);
    return outcome;
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
  const result = await mutateRequest(db, org, requestId, (row) => assertClosedDecision(db, org, row, actorId, decision), async (row) => {
    const blocked = nodesOf(row).find(unsupportedNode);
    if (blocked)
      throw new OrganizationPermissionError("UNSUPPORTED_APPROVAL_NODE", 409, unsupportedNodeMessage(blocked, "审批"));
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
    const namedActor = await resolveLedgerActor(db, actor);
    const decisions: DecisionEvent[] = [
      ...state.history,
      {
        stageIndex: Number(row.stage_index),
        userId: actorId,
        decision,
        comment,
        at: new Date().toISOString(),
        actorName: ledgerActorName(namedActor),
        nameSource: "snapshot",
      },
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
      if (unsupportedNode(nodes[stage]))
        throw new OrganizationPermissionError("UNSUPPORTED_APPROVAL_NODE", 409, unsupportedNodeMessage(nodes[stage], "审批"));
      if (nodes[stage].mode === "auto_reject")
        return { status: "rejected", stage, decisions: [...decisions, { stageIndex: stage, decision: "reject", automatic: true, actorName: "系统", nameSource: "snapshot" }] };
      decisions.push({ stageIndex: stage, decision: nodes[stage].mode === "cc" ? "cc" : "approve", automatic: true, actorName: "系统", nameSource: "snapshot", at: new Date().toISOString() });
      stage += 1;
    }
    if (stage < nodes.length) return { status: "pending", stage, decisions };
    const snapshot = snapshotOf(row);
    const catalog = await organizationResourceCatalog(db, org);
    if (snapshot.targets.some((target) => !catalog.some((item) => sameTarget(item, target))))
      throw new OrganizationPermissionError("INVALID_RESOURCE", 409, "申请中的资源已经不存在");
    const member = await activeMember(db, org, row.requester_id);
    if (!member) throw new OrganizationPermissionError("REQUESTER_INACTIVE", 409, "申请人已经不是有效组织成员");
    try {
      const grantIds = await grantApproved(db, org, row.requester_id, row.kind, snapshot, row.id, serverNow(), row.role_id, namedActor, comment || decision);
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
  }, async (row, outcome) => {
    const action = outcome.status === "approved" ? "审批通过" : outcome.status === "rejected" ? "审批拒绝" : outcome.blockReason ? "审批未生效" : "节点通过";
    await recordGrantLedger(db, org, await resolveLedgerActor(db, actor), action, comment || decision, {
      before: { status: row.status, stageIndex: Number(row.stage_index) },
      after: { status: outcome.status, grantIds: outcome.grantIds, blockReason: outcome.blockReason, source: "request" },
      targets: snapshotOf(row).targets,
      requestId,
      grantId: outcome.grantIds[0] ?? null,
      channel: "request",
    });
  });
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
  const result = await mutateRequest(db, org, requestId, (row) => assertClosedWithdraw(db, org, row, actorId), async (row) => {
    if (row.requester_id !== actorId)
      throw new OrganizationPermissionError("REQUEST_NOT_WITHDRAWABLE", 403, "只能撤回自己的待审批申请");
    const decisions = parse<DecisionEvent[]>(row.decisions_json, []);
    const namedActor = await resolveLedgerActor(db, actor);
    decisions.push({
      decision: "withdraw",
      userId: actor.id ?? undefined,
      at: new Date().toISOString(),
      comment: reason,
      actorName: ledgerActorName(namedActor),
      nameSource: "snapshot",
    });
    return { status: "withdrawn", stage: Number(row.stage_index), decisions };
  }, async (row, outcome) => {
    await recordGrantLedger(db, org, await resolveLedgerActor(db, actor), "撤回授权申请", reason, {
      before: { status: row.status, stageIndex: Number(row.stage_index) },
      after: { status: outcome.status, source: "request" },
      targets: snapshotOf(row).targets,
      requestId,
      channel: "request",
    });
  });
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
    const before = workflow.nodes.map((node) => ({
      ...node,
      resolvedApproverIds: [...node.resolvedApproverIds],
      passApproverIds: node.passApproverIds ? [...node.passApproverIds] : node.passApproverIds,
      approverNames: node.approverNames ? { ...node.approverNames } : undefined,
    }));
    const stage = Number(row.stage_index);
    const current = workflow.nodes[stage];
    if (!current || !nodeAllows(current, revision.type)) {
      const action = revision.type === "transfer" ? "转交" : revision.type === "add_sign" ? "加签" : "回退";
      throw new OrganizationPermissionError("NODE_OPERATION_DISABLED", 400, `当前节点不允许${action}`);
    }
    if (revision.type === "rollback") {
      const target = revision.stageIndex ?? stage - 1;
      const destination = workflow.nodes[target];
      if (!Number.isInteger(target) || target < 0 || target >= stage || !destination)
        throw new OrganizationPermissionError("INVALID_ROLLBACK", 400, "只能回退到当前节点之前的真实节点");
      workflow.nodes.forEach((node, index) => {
        const prior = before[index];
        if (index < target || !prior) return;
        node.resolvedApproverIds = [...prior.resolvedApproverIds];
        if (prior.passApproverIds) node.passApproverIds = [...prior.passApproverIds];
        node.approverNames = prior.approverNames ? { ...prior.approverNames } : undefined;
      });
      const decisions = state.history.map((item) =>
        (item.stageIndex ?? -1) >= target && !item.superseded ? { ...item, superseded: true } : item,
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
      if (revision.userId === row.requester_id && node.allowSelf !== true)
        throw new OrganizationPermissionError("SELF_APPROVAL_FORBIDDEN", 409, "这个节点不允许申请人本人审批");
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
      node.approverNames = { ...(node.approverNames ?? {}), ...(await accountNames(db, [nextId])) };
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

export interface GrantLedgerFilter {
  action?: string;
  actor?: string;
  target?: string;
  type?: ResourceRef["type"];
  from?: number;
  to?: number;
}

function containsResourceType(value: unknown, type: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsResourceType(item, type));
  const record = value as Record<string, unknown>;
  if (record.type === type && typeof record.id === "string") return true;
  return Object.values(record).some((item) => containsResourceType(item, type));
}

function snapshotFacts(before: unknown, after: unknown) {
  const names = new Map<string, string>();
  const roles: string[] = [];
  const subjects: string[] = [];
  const sources: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.name === "string" && record.name.trim()) {
      const key = typeof record.type === "string" ? `${record.type}:${record.id}` : record.id;
      if (!names.has(key)) names.set(key, record.name);
    }
    if (typeof record.roleName === "string" && record.roleName && !roles.includes(record.roleName)) roles.push(record.roleName);
    // A role snapshot has a name and permission codes, and no resource target. The ledger list uses this role field.
    const roleLabel = typeof record.name === "string" ? record.name.trim() : "";
    if (
      roleLabel &&
      Array.isArray(record.permissionCodes) &&
      record.permissionCodes.every((code) => typeof code === "string") &&
      !roles.includes(roleLabel)
    )
      roles.push(roleLabel);
    if (typeof record.subjectName === "string" && record.subjectName && !subjects.includes(record.subjectName)) subjects.push(record.subjectName);
    if (typeof record.source === "string" && record.source && !sources.includes(record.source)) sources.push(record.source);
    Object.values(record).forEach(visit);
  };
  visit(before);
  visit(after);
  return { names, role: roles.join("、"), subject: subjects.join("、"), source: sources.join("、") };
}

function ledgerTime(value: unknown) {
  if (value instanceof Date) return value.getTime();
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : NaN;
}

export async function listGrantLedger(
  db: EnvmanDatabase,
  org: string,
  viewerId: string,
  exporting = false,
  filter: GrantLedgerFilter = {},
) {
  const access = await loadOrganizationAccess(db, org, viewerId);
  if (exporting && !access.allows("audit.export"))
    throw new OrganizationPermissionError("ACTION_FORBIDDEN", 403, "没有导出台账的权限");
  const orgWide = access.allows("audit.view") || access.allows("approval.view") || access.allows("authorization.view");
  const targetVisible = (target: ResourceRef) => access.allows("audit.view", target) || access.allows("approval.view", target);
  if (!orgWide && !access.catalog.some((item) => targetVisible(item)))
    throw new OrganizationPermissionError("ACTION_FORBIDDEN", 403, "没有查看台账的权限");
  const rows = await db
    .prepare(
      "SELECT * FROM organization_grant_ledger WHERE organization_id = ? ORDER BY created_at DESC, id DESC",
    )
    .all<Record<string, unknown>>(org);
  const needle = filter.target?.trim().toLowerCase() ?? "";
  const actorQuery = filter.actor?.trim().toLowerCase() ?? "";
  const actionQuery = filter.action?.trim().toLowerCase() ?? "";
  return {
    items: rows.flatMap((row) => {
      const stored = parse<Array<ResourceRef & { name?: string }>>(row.target_refs_json, []);
      if (!orgWide && (stored.length === 0 || !stored.every((target) => targetVisible(target)))) return [];
      const before = redactLedger(parse<unknown>(row.before_json, null));
      const after = redactLedger(parse<unknown>(row.after_json, null));
      const facts = snapshotFacts(before, after);
      const targets = stored.map((target) => ({
        type: target.type,
        id: target.id,
        // Names stay inside the written snapshot. A current catalog name would rewrite history after a rename.
        name: target.name?.trim() || facts.names.get(resourceKey(target)) || "",
      }));
      const createdAt = row.created_at;
      const time = ledgerTime(createdAt);
      const actorName = String(row.actor_name ?? "");
      const action = String(row.action ?? "");
      const source = [...new Set([row.channel, ...facts.source.split("、")].map((item) => String(item ?? "").trim()).filter(Boolean))].join("、");
      if (actionQuery && !action.toLowerCase().includes(actionQuery)) return [];
      if (actorQuery && String(row.actor_id ?? "") !== filter.actor?.trim() && !actorName.toLowerCase().includes(actorQuery)) return [];
      if (filter.from !== undefined && !(time >= filter.from)) return [];
      if (filter.to !== undefined && !(time <= filter.to)) return [];
      if (filter.type && !targets.some((target) => target.type === filter.type) && !containsResourceType(before, filter.type) && !containsResourceType(after, filter.type)) return [];
      if (needle) {
        const named = targets.some((target) => target.id === filter.target?.trim() || target.name.toLowerCase().includes(needle));
        const snapshot = JSON.stringify({ before, after, reason: row.reason, role: facts.role, subject: facts.subject }).toLowerCase();
        if (!named && !snapshot.includes(needle)) return [];
      }
      return [{
        id: row.id,
        actorId: row.actor_id,
        actorName,
        action,
        reason: row.reason,
        before,
        after,
        targets,
        role: facts.role,
        subject: facts.subject,
        source,
        requestId: row.request_id,
        grantId: row.grant_id,
        channel: row.channel,
        createdAt,
      }];
    }),
  };
}
