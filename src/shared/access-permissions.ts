import { parseSqlStatements } from "./sql-statements.js";

export const CAPABILITIES = ["web", "ssh", "logs", "database", "redis", "knowledge", "maintenance"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_ACTIONS = {
  web: ["view", "use", "manage"],
  ssh: ["view", "use", "manage"],
  logs: ["view", "manage"],
  database: ["read", "write", "manage"],
  redis: ["view", "write", "manage"],
  knowledge: ["view", "edit"],
  maintenance: ["view", "control", "script", "manage", "install"],
} as const;

export type CapabilityAction<C extends Capability = Capability> = (typeof CAPABILITY_ACTIONS)[C][number];
export type PermissionMap = Partial<Record<Capability, string[]>>;
export type ItemMap = Partial<Record<Capability, string[]>>;

export const SCOPE_KINDS = ["environment_group", "environment", "ssh_connection", "database_connection", "redis_connection"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  web: "Web 入口",
  ssh: "SSH 终端",
  logs: "日志",
  database: "数据库",
  redis: "Redis",
  knowledge: "知识库",
  maintenance: "服务维护",
};

export const ACTION_LABELS: { [C in Capability]: Record<(typeof CAPABILITY_ACTIONS)[C][number], string> } = {
  web: { view: "查看并打开", use: "使用已存账号", manage: "编辑入口和账号" },
  ssh: { view: "查看连接", use: "登录使用", manage: "编辑连接" },
  logs: { view: "查看日志", manage: "编辑日志来源" },
  database: { read: "查询和导出", write: "修改", manage: "编辑连接" },
  redis: { view: "查看", write: "修改", manage: "编辑连接" },
  knowledge: { view: "查看", edit: "编辑" },
  maintenance: { view: "查看", control: "启动、停止、重启", script: "执行脚本", manage: "编辑服务", install: "安装和维护主机监控" },
};

const IMPLICATIONS: Record<Capability, Partial<Record<string, readonly string[]>>> = {
  web: { manage: ["use", "view"], use: ["view"] },
  ssh: { manage: ["use", "view"], use: ["view"] },
  logs: { manage: ["view"] },
  database: { manage: ["write", "read"], write: ["read"] },
  redis: { manage: ["write", "view"], write: ["view"] },
  knowledge: { edit: ["view"] },
  maintenance: { control: ["view"], script: ["view"], manage: ["view"], install: ["view"] },
};

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export function connectionCapability(kind: "ssh_connection" | "database_connection" | "redis_connection"): Capability {
  if (kind === "ssh_connection") return "ssh";
  if (kind === "database_connection") return "database";
  return "redis";
}

export function expandActions(capability: Capability, actions: Iterable<string>): string[] {
  const order = CAPABILITY_ACTIONS[capability];
  const known = new Set<string>(order);
  const selected = new Set<string>();
  const visit = (action: string) => {
    if (!known.has(action) || selected.has(action)) return;
    selected.add(action);
    for (const implied of IMPLICATIONS[capability][action] ?? []) visit(implied);
  };
  for (const action of actions) visit(action);
  return order.filter((action) => selected.has(action));
}

export function expandPermissions(permissions: PermissionMap): PermissionMap {
  const result: PermissionMap = {};
  for (const capability of CAPABILITIES) {
    const actions = permissions[capability];
    if (!actions?.length) continue;
    const expanded = expandActions(capability, actions);
    if (expanded.length) result[capability] = expanded;
  }
  return result;
}

export function fullPermissions(kind: ScopeKind): PermissionMap {
  if (kind === "ssh_connection" || kind === "database_connection" || kind === "redis_connection") {
    const capability = connectionCapability(kind);
    return { [capability]: [...CAPABILITY_ACTIONS[capability]] };
  }
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, [...CAPABILITY_ACTIONS[capability]]])) as PermissionMap;
}

export function heavierActions(capability: Capability, action: string): string[] {
  const implications = IMPLICATIONS[capability];
  const heavier = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of CAPABILITY_ACTIONS[capability]) {
      if (candidate === action || heavier.has(candidate)) continue;
      const implied = implications[candidate] ?? [];
      if (implied.some((item) => item === action || heavier.has(item))) {
        heavier.add(candidate);
        changed = true;
      }
    }
  }
  return CAPABILITY_ACTIONS[capability].filter((candidate) => heavier.has(candidate));
}

export function permissionSummary(permissions: PermissionMap): string {
  const parts: string[] = [];
  for (const capability of CAPABILITIES) {
    const actions = permissions[capability] ?? [];
    if (!actions.length) continue;
    const labels = actions.map((action) => (ACTION_LABELS[capability] as Record<string, string>)[action]).filter(Boolean);
    parts.push(`${CAPABILITY_LABELS[capability]}：${labels.join("、")}`);
  }
  return parts.join("；");
}

function statementText(sql: string): string {
  return sql.replace(/^\s*(?:(?:--[^\n]*|#[^\n]*)(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+/, "").trim();
}

export function sqlRequiresWrite(sql: string): boolean {
  const statements = parseSqlStatements(sql).map((item) => statementText(item.sql)).filter(Boolean);
  if (!statements.length) return true;
  return statements.some((statement) => {
    if (/\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/i.test(statement)) return true;
    if (/^WITH\b/i.test(statement)) return /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE)\b/i.test(statement);
    return !/^(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|TABLE)\b/i.test(statement);
  });
}
