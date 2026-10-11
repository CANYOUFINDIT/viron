/** Shared organization permission vocabulary. Permission names never confer privileges. */
export const RESOURCE_TYPES = [
  "environment",
  "web_entry",
  "ssh_connection",
  "database_connection",
  "redis_connection",
  "environment_log",
  "knowledge_node",
  "service",
  "service_deployment",
  "service_script",
  "monitor_host",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export interface ResourceRef {
  type: ResourceType;
  id: string;
}
export type SubjectType = "user" | "project" | "organization";
export interface ManagementScope {
  kind: "organization" | "project" | "resources";
  ids: string[];
  includeChildren: boolean;
}
export interface PermissionDefinition {
  code: string;
  label: string;
  module: string;
  scope: "organization" | "project" | "resource" | "personal";
}
const modulePermissions = (
  module: string,
  scope: PermissionDefinition["scope"],
  items: Array<[string, string]>,
): PermissionDefinition[] =>
  items.map(([code, label]) => ({ module, scope, code, label }));
export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  ...modulePermissions("组织与成员", "organization", [
    ["organization.view", "查看组织"],
    ["organization.update", "修改组织"],
  ]),
  ...modulePermissions("组织与成员", "project", [
    ["member.view", "查看成员"],
    ["member.invite", "邀请成员"],
    ["member.remove", "移除成员"],
    ["team.view", "查看子组织"],
    ["team.create", "创建子组织"],
    ["team.update", "修改子组织"],
  ]),
  ...modulePermissions("资源配置", "personal", [
    ["environment.catalog", "查看资源目录"],
  ]),
  ...modulePermissions("资源配置", "organization", [
    ["environment.create", "创建环境与连接"],
  ]),
  ...modulePermissions("资源配置", "resource", [
    ["environment.view", "查看环境配置"],
    ["environment.update", "维护环境配置"],
    ...[
      "web",
      "ssh",
      "database",
      "redis",
      "logs",
      "knowledge",
      "maintenance",
    ].map((cap): [string, string] => [
      `resource.${cap}.configure`,
      `维护 ${cap} 配置`,
    ]),
  ]),
  ...modulePermissions("Web 入口", "resource", [
    ["web.view", "查看与打开"],
    ["web.use", "使用已存账号"],
    ["web.reveal", "查看凭据"],
  ]),
  ...modulePermissions("SSH / SFTP", "resource", [
    ["ssh.view", "查看连接"],
    ["ssh.use", "登录终端"],
    ["ssh.browse", "浏览文件"],
    ["ssh.upload", "上传文件与创建目录"],
    ["ssh.download", "下载文件"],
    ["ssh.delete", "删除、重命名与修改文件权限"],
  ]),
  ...modulePermissions("数据库", "resource", [
    ["database.read", "查询数据"],
    ["database.export", "导出数据"],
    ["database.write", "修改数据"],
    ["database.ddl", "变更结构"],
  ]),
  ...modulePermissions("Redis", "resource", [
    ["redis.view", "查看"],
    ["redis.write", "修改"],
  ]),
  ...modulePermissions("环境日志", "resource", [["logs.view", "查看日志"]]),
  ...modulePermissions("知识库", "resource", [
    ["knowledge.view", "查看"],
    ["knowledge.edit", "编辑内容"],
  ]),
  ...modulePermissions("服务维护", "resource", [
    ["maintenance.view", "查看"],
    ["maintenance.control", "启停与重启"],
    ["maintenance.script", "执行脚本"],
    ["maintenance.install", "维护主机监控"],
  ]),
  ...modulePermissions("证书与密钥", "organization", [
    ["credential.view", "查看引用与证书"],
    ["credential.update", "维护证书与密钥"],
    ["credential.export", "导出私钥或凭据"],
  ]),
  ...modulePermissions("授权维护", "resource", [
    ["authorization.view", "查看授权"],
    ["authorization.create", "创建授权"],
    ["authorization.update", "修改与启停授权"],
    ["authorization.revoke", "撤销授权"],
  ]),
  ...modulePermissions("授权维护", "personal", [
    ["authorization.request", "申请授权"],
  ]),
  ...modulePermissions("角色维护", "organization", [
    ["role.view", "查看角色"],
    ["role.create", "创建与复制角色"],
    ["role.update", "维护角色与分配"],
    ["role.delete", "删除未使用角色"],
  ]),
  ...modulePermissions("审批与台账", "resource", [
    ["approval.view", "查看申请"],
    ["approval.approve", "审批通过"],
    ["approval.reject", "审批拒绝"],
    ["audit.view", "查看台账"],
  ]),
  ...modulePermissions("审批与台账", "organization", [
    ["approval.workflow", "维护审批流程"],
    ["audit.export", "导出台账"],
  ]),
  ...modulePermissions("连接工具", "organization", [
    ["tool.sync", "连接同步"],
    ["tool.import", "导入连接"],
    ["tool.export", "导出连接"],
    ["tool.copy", "复制连接"],
    ["tool.inspect", "连接巡检"],
  ]),
];
export const PERMISSION_CODES = PERMISSION_DEFINITIONS.map((p) => p.code);
export const RESOURCE_CAPABILITIES: Record<ResourceType, string> = {
  environment: "environment",
  web_entry: "web",
  ssh_connection: "ssh",
  database_connection: "database",
  redis_connection: "redis",
  environment_log: "logs",
  knowledge_node: "knowledge",
  service: "maintenance",
  service_deployment: "maintenance",
  service_script: "maintenance",
  monitor_host: "maintenance",
};
export const resourceKey = (ref: ResourceRef) => `${ref.type}:${ref.id}`;
export interface OrganizationRole {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  permissionCodes: string[];
  version: number;
}
export interface RoleAssignment {
  id: string;
  roleId: string;
  subjectType: SubjectType;
  subjectId: string;
  managementScope: ManagementScope;
  enabled: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  reason: string;
}
export interface RoleDataGrant {
  id: string;
  roleId: string;
  target: ResourceRef;
  batchId: string;
  enabled: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  reason: string;
  source: string;
}
export interface FeatureGrant {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  targets: ResourceRef[];
  features: { mcp: boolean; agent: boolean; webPlugins: boolean };
  enabled: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  reason: string;
}
export interface ResourceCatalogItem extends ResourceRef {
  name: string;
  capability: string;
  environmentIds: string[];
  groupIds: string[];
}
export function validAt(
  record: {
    enabled: boolean;
    startsAt: string | null;
    expiresAt: string | null;
  },
  now = Date.now(),
): boolean {
  return (
    record.enabled &&
    (!record.startsAt || Date.parse(record.startsAt) <= now) &&
    (!record.expiresAt || Date.parse(record.expiresAt) > now)
  );
}
export function legacyOperationCodes(
  capability: string,
  action: string,
): string[] {
  if (action === "manage") return [`resource.${capability}.configure`];
  return [`${capability}.${action}`];
}
export interface RoleAccessState {
  roles: OrganizationRole[];
  assignments: RoleAssignment[];
  dataGrants: RoleDataGrant[];
  featureGrants: FeatureGrant[];
  permissions: PermissionDefinition[];
  capabilities: Record<
    | "roleView"
    | "roleCreate"
    | "roleUpdate"
    | "roleDelete"
    | "authorizationCreate"
    | "authorizationUpdate"
    | "authorizationRevoke",
    boolean
  >;
  resourceCapabilities: Record<
    string,
    { create: boolean; update: boolean; revoke: boolean }
  >;
}

export const RESOURCE_TYPE_LABELS: Record<ResourceType,string> = {environment:"环境",web_entry:"Web 入口",ssh_connection:"SSH 连接",database_connection:"数据库连接",redis_connection:"Redis 连接",environment_log:"环境日志",knowledge_node:"知识库节点",service:"服务",service_deployment:"服务部署",service_script:"脚本",monitor_host:"主机监控"};
