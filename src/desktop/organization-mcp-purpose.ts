import { AsyncLocalStorage } from "node:async_hooks";
import type { DesktopExecutionCheck } from "../shared/desktop-execution-authorization.js";

const SSH_CREDENTIAL_CODES = new Set(["ssh.use", "ssh.browse", "ssh.download", "ssh.upload", "ssh.delete"]);

/** Checks Core already allowed for the MCP call that is about to open a transport. */
export const organizationMcpPurpose = new AsyncLocalStorage<DesktopExecutionCheck[]>();

export interface SshCredentialPurpose {
  code: "ssh.use" | "ssh.browse" | "ssh.download" | "ssh.upload" | "ssh.delete" | "logs.view";
  targetType: "ssh_connection" | "environment_log";
  targetId: string;
}

/** The current call's SSH or log check. A directory grant is not reported as terminal use. */
export function sshCredentialPurpose(connectionId: string): SshCredentialPurpose | undefined {
  const checks = organizationMcpPurpose.getStore() ?? [];
  const id = connectionId.toLowerCase();
  const ssh = checks.find((check) => check.target.type === "ssh_connection" && check.target.id === id && SSH_CREDENTIAL_CODES.has(check.code));
  if (ssh) return { code: ssh.code as SshCredentialPurpose["code"], targetType: "ssh_connection", targetId: ssh.target.id };
  const log = checks.find((check) => check.target.type === "environment_log" && check.code === "logs.view");
  if (log) return { code: "logs.view", targetType: "environment_log", targetId: log.target.id };
  return undefined;
}
