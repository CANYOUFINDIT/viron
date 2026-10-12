import { databaseSqlActions, type DatabaseSqlAction } from "./access-permissions.js";

export type DatabaseTaskKind = "backup" | "restore" | "transfer" | "import";
export type DatabaseTaskAction = DatabaseSqlAction;

export interface DatabaseTaskAccessPlan {
  operations: DatabaseTaskAction[];
  targetConnectionId: string | null;
  targetOperations: DatabaseTaskAction[];
}

const ACTION_ORDER: DatabaseTaskAction[] = ["read", "export", "write", "ddl"];

function unique(actions: readonly DatabaseTaskAction[]): DatabaseTaskAction[] {
  return ACTION_ORDER.filter((action) => actions.includes(action));
}

function isAction(value: unknown): value is DatabaseTaskAction {
  return value === "read" || value === "export" || value === "write" || value === "ddl";
}

function booleanFlag(details: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof details[key] === "boolean" ? Boolean(details[key]) : fallback;
}

function dataSyncWrites(details: Record<string, unknown>): boolean {
  const data = details.data && typeof details.data === "object" ? details.data as Record<string, unknown> : {};
  return data.insert !== false || data.update !== false || data.delete !== false;
}

/**
 * Permission set for one database background task.
 * Backup reads and exports. Transfer and sync read the source; structure DDL and data writes run on the target.
 * Data mode uses an existing target. Creating that database, or TRUNCATE when replacing rows, is target DDL.
 * Restore uses the same statement catalog as an interactive SQL job.
 */
export function databaseTaskAccessPlan(type: DatabaseTaskKind, details: Record<string, unknown>): DatabaseTaskAccessPlan {
  const targetConnectionId = typeof details.targetConnectionId === "string" ? details.targetConnectionId : null;
  if (type === "backup") return { operations: ["read", "export"], targetConnectionId: null, targetOperations: [] };
  if (type === "restore") {
    const listed = Array.isArray(details.restoreActions) ? unique(details.restoreActions.filter(isAction)) : null;
    const operations = listed ?? databaseSqlActions(typeof details.restoreSql === "string" ? details.restoreSql : "");
    return { operations, targetConnectionId: null, targetOperations: [] };
  }
  if (type === "import" || !targetConnectionId) return { operations: ["write"], targetConnectionId: null, targetOperations: [] };
  if (details.syncMode === "data" || details.syncMode === "structure") {
    const targetOperations: DatabaseTaskAction[] = ["read"];
    if (details.syncMode === "structure") targetOperations.push("ddl");
    else if (dataSyncWrites(details)) targetOperations.push("write");
    return { operations: ["read"], targetConnectionId, targetOperations: unique(targetOperations) };
  }
  const includeStructure = booleanFlag(details, "includeStructure", true);
  const includeData = booleanFlag(details, "includeData", true);
  const dropExisting = booleanFlag(details, "dropExisting", false);
  const targetOperations: DatabaseTaskAction[] = [];
  if (includeStructure || (includeData && dropExisting)) targetOperations.push("ddl");
  if (includeData) targetOperations.push("write");
  return { operations: ["read"], targetConnectionId, targetOperations: unique(targetOperations) };
}
