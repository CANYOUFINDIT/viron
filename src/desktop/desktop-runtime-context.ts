import { AsyncLocalStorage } from "node:async_hooks";
import type { McpApprovalMode } from "../shared/mcp-settings.js";
import type { DeviceIdentity } from "./device-identity.js";
import type { DesktopAgentRuntime } from "./agent-runtime.js";
import type { DesktopConnectionInspectionRuntime } from "./connection-inspection-runtime.js";
import type { DesktopDatabaseOperationRuntime } from "./database-operations-runtime.js";
import type { DesktopDatabaseRuntime } from "./database-runtime.js";
import type { DesktopLogRuntime } from "./log-runtime.js";
import type { DesktopRedisRuntime } from "./redis-runtime.js";
import type { DesktopSftpRuntime } from "./sftp-runtime.js";
import type { DesktopSshRuntime } from "./ssh-runtime.js";

export interface DesktopAuthContext {
  user: { id: string; username: string };
  workspace: { type: "personal" | "organization"; id: string };
}

export interface DesktopRuntimeRegistration {
  id: string;
  localId: string;
  activity: () => number | null;
  close: (reason: string) => Promise<void> | void;
}

export interface DesktopCoreRuntimes {
  ssh: DesktopSshRuntime;
  sftp: DesktopSftpRuntime;
  log: DesktopLogRuntime;
  database: DesktopDatabaseRuntime;
  databaseOperation: DesktopDatabaseOperationRuntime;
  redis: DesktopRedisRuntime;
  connectionInspection: DesktopConnectionInspectionRuntime;
}

export let desktopSshRuntime: DesktopSshRuntime;
export let desktopSftpRuntime: DesktopSftpRuntime;
export let desktopLogRuntime: DesktopLogRuntime;
export let desktopDatabaseRuntime: DesktopDatabaseRuntime;
export let desktopDatabaseOperationRuntime: DesktopDatabaseOperationRuntime;
export let desktopRedisRuntime: DesktopRedisRuntime;
export let desktopConnectionInspectionRuntime: DesktopConnectionInspectionRuntime;
export let desktopAgentRuntime: DesktopAgentRuntime;

export const desktopRuntimeRegistrations = new Map<string, DesktopRuntimeRegistration>();
export const pendingCredentialRequests = new Set<string>();
export const desktopAuditSourceContext = new AsyncLocalStorage<"manual" | "mcp">();
export const desktopMcpApprovalModeContext = new AsyncLocalStorage<McpApprovalMode>();
export const desktopDeviceAuthorizationContext = new AsyncLocalStorage<{
  auth: DesktopAuthContext;
  identity: DeviceIdentity;
  endpoint: string;
}>();

let coreRuntimesInitialized = false;
let agentRuntimeInitialized = false;

export function initializeDesktopRuntimeContext(coreRuntimes: DesktopCoreRuntimes): void {
  if (coreRuntimesInitialized) throw new Error("Desktop runtime context is already initialized");
  desktopSshRuntime = coreRuntimes.ssh;
  desktopSftpRuntime = coreRuntimes.sftp;
  desktopLogRuntime = coreRuntimes.log;
  desktopDatabaseRuntime = coreRuntimes.database;
  desktopDatabaseOperationRuntime = coreRuntimes.databaseOperation;
  desktopRedisRuntime = coreRuntimes.redis;
  desktopConnectionInspectionRuntime = coreRuntimes.connectionInspection;
  coreRuntimesInitialized = true;
}

export function assertDesktopRuntimeContextInitialized(): void {
  if (!coreRuntimesInitialized) throw new Error("Desktop runtime context is not initialized");
}

export function setDesktopAgentRuntime(runtime: DesktopAgentRuntime): void {
  assertDesktopRuntimeContextInitialized();
  if (agentRuntimeInitialized) throw new Error("Desktop Agent runtime is already initialized");
  desktopAgentRuntime = runtime;
  agentRuntimeInitialized = true;
}
