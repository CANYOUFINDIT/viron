import type { Component } from "vue";
import type { DatabaseNavigatorTarget } from "../../database-navigator-menu";

export interface DatabaseWorkbenchProps {
  environmentId?: string;
  initialConnectionId?: string;
  workspaceKey: string;
  active: boolean;
}

export interface DatabaseConnection {
  id: string;
  profileParentId: string | null;
  profileName: string;
  type: "database";
  name: string;
  engine: "mysql" | "mariadb";
  host: string;
  port: number;
  username: string;
  environmentId: string | null;
  environmentIds: string[];
  connectionGroupId: string | null;
  connectionGroupPath: string | null;
  defaultDatabase: string;
  connectionMode: "tcp" | "sshTunnel" | "httpTunnel";
  options: Record<string, unknown>;
  canManage: boolean;
  starred: boolean;
  color: string;
}

export interface ConnectionGroupItem { id: string; parentId: string | null; name: string; path: string }
export interface OrganizationGrant { id: string; granteeType: "user" | "project"; granteeId: string; granteeName: string; resourceType: string; resourceId: string }
export interface OrganizationShareDetail {
  members: Array<{ id: string; username: string; role: "admin" | "member"; status: string }>;
  projects: Array<{ id: string; name: string }>;
  grants: OrganizationGrant[];
}

export interface SchemaItem { name: string; charset: string; collation: string }
export interface DatabaseObject {
  name: string;
  sourceCategory?: ObjectCategory;
  rowCount?: number;
  dataSize?: number;
  engine?: string;
  comment?: string;
  tableName?: string;
  status?: string;
  event?: string;
  timing?: string;
  eventType?: string;
  createdAt?: string;
  updatedAt?: string;
  collation?: string;
}
export type ObjectCategory = "tables" | "views" | "procedures" | "functions" | "triggers" | "events";
export type BrowserCategory = "tables" | "views" | "functions" | "events";
export type UtilityCategory = "queries" | "backups";
export type NavigatorCategoryKey = BrowserCategory | UtilityCategory;

export interface ObjectCategoryDefinition {
  key: BrowserCategory;
  label: string;
  icon: Component;
  singular: string;
  sources: ObjectCategory[];
}

export interface UtilityCategoryDefinition {
  key: UtilityCategory;
  label: string;
  icon: Component;
}

export type NavigatorCategory = ObjectCategoryDefinition | UtilityCategoryDefinition;

export interface QueryResultSet {
  columns: Array<{ name: string; table: string; type: number }>;
  rows: Array<Record<string, unknown>>;
  affectedRows: number;
  insertId: string | number;
  info: string;
  truncated: boolean;
  statement?: string;
  error?: string;
}

export interface QueryJob {
  id: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  continueOnError?: boolean;
  resultSets: QueryResultSet[];
}

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  database: string;
  job: QueryJob | null;
  activeResult: number;
  kind: "sql" | "command-line" | "data" | "objects" | "utility" | "table-design" | "automation" | "model" | "user" | "bi";
  table?: string;
  readOnly?: boolean;
  category?: BrowserCategory;
  utilityCategory?: UtilityCategory;
  tableAction?: { id: string; type: "import" | "export"; format?: "csv" | "xlsx" | "sql" };
  dirty?: boolean;
  savedQueryId?: string;
  savedQuerySql?: string;
  savedQueryName?: string;
  savedQueryDatabase?: string;
}

export interface ConnectionNavigatorTarget {
  kind: "connection";
  connectionId: string;
}

export type WorkbenchNavigatorTarget = DatabaseNavigatorTarget | ConnectionNavigatorTarget;

export interface HistoryItem {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  sql: string;
  status: string;
  durationMs: number;
  rowCount: number;
  error: string;
  createdAt: string;
}

export interface FavoriteItem { id: string; connectionId: string; database: string; name: string; sql: string; updatedAt: string }
export interface SavedQueryItem {
  id: string;
  connectionId: string;
  database: string;
  name: string;
  sql: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}
export interface DatabaseTreeTask {
  id: string;
  type: "backup" | "restore" | "transfer" | "import";
  connectionId: string | null;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  progress: number;
  title: string;
  details: Record<string, unknown>;
  downloadable: boolean;
  logs: string[];
  error: string;
  createdAt: string;
  completedAt?: string;
  outputFilename: string | null;
}
export interface ObjectFavoriteItem {
  id: string;
  connectionId: string;
  connectionName: string;
  environmentId: string | null;
  engine: "mysql" | "mariadb";
  host: string;
  port: number;
  targetType: "database" | "table";
  database: string;
  table: string;
  updatedAt: string;
}
export interface ObjectGroupItem {
  id: string;
  connectionId: string;
  database: string;
  category: NavigatorCategoryKey;
  name: string;
  members: Array<{ objectName: string; objectSource: string }>;
  createdAt: string;
  updatedAt: string;
}
export interface NavigatorObjectClipboard {
  database: string;
  category: BrowserCategory;
  sourceCategory: ObjectCategory;
  name: string;
  ddl: string;
}

export interface DatabaseSearchResult {
  key: string;
  category: BrowserCategory;
  categoryLabel: string;
  item: DatabaseObject;
}

export type TableMaintenanceOperation =
  | "empty"
  | "truncate"
  | "analyze"
  | "check"
  | "checkQuick"
  | "checkFast"
  | "checkChanged"
  | "checkExtended"
  | "optimize"
  | "repairQuick"
  | "repairExtended";
