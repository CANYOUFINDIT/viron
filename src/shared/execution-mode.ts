export type DesktopExecutionMode = "local" | "server";
export type ExecutionTarget = "local" | "server" | "unavailable";

export interface ExecutionCapabilities {
  desktopLocal?: {
    web?: boolean;
    ssh?: boolean;
    sftp?: boolean;
    logs?: boolean;
    database?: boolean;
    redis?: boolean;
    inspection?: boolean;
  };
  serverForwarding?: {
    enabled: boolean;
    web: boolean;
    ssh: boolean;
    sftp: boolean;
    logs: boolean;
    database: boolean;
    redis?: boolean;
  };
}

export interface ExecutionTargets {
  web: ExecutionTarget;
  ssh: ExecutionTarget;
  sftp: ExecutionTarget;
  logs: ExecutionTarget;
  database: ExecutionTarget;
  redis: ExecutionTarget;
  inspectionSsh: ExecutionTarget;
  inspectionDatabase: ExecutionTarget;
  inspectionRedis: ExecutionTarget;
}

function localTarget(enabled: boolean | undefined): ExecutionTarget {
  return enabled ? "local" : "unavailable";
}

export function resolveExecutionTargets(
  mode: DesktopExecutionMode,
  capabilities: ExecutionCapabilities | null | undefined,
): ExecutionTargets {
  const local = capabilities?.desktopLocal;
  const forwarding = capabilities?.serverForwarding;
  if (mode !== "server") {
    return {
      web: localTarget(local?.web),
      ssh: localTarget(local?.ssh),
      sftp: localTarget(local?.sftp),
      logs: localTarget(local?.logs),
      database: localTarget(local?.database),
      redis: localTarget(local?.redis),
      inspectionSsh: local?.inspection && local.ssh ? "local" : "unavailable",
      inspectionDatabase: local?.inspection && local.database ? "local" : "unavailable",
      inspectionRedis: local?.inspection && local.redis ? "local" : "unavailable",
    };
  }

  const forwardingEnabled = forwarding?.enabled === true;

  return {
    web: forwardingEnabled && forwarding?.web ? "server" : localTarget(local?.web),
    ssh: forwardingEnabled && forwarding?.ssh ? "server" : "unavailable",
    sftp: forwardingEnabled && forwarding?.sftp ? "server" : "unavailable",
    logs: forwardingEnabled && forwarding?.logs ? "server" : "unavailable",
    database: forwardingEnabled && forwarding?.database ? "server" : "unavailable",
    redis: forwardingEnabled && forwarding?.redis ? "server" : "unavailable",
    inspectionSsh: forwardingEnabled && forwarding?.ssh ? "server" : "unavailable",
    inspectionDatabase: forwardingEnabled && forwarding?.database ? "server" : "unavailable",
    inspectionRedis: forwardingEnabled && forwarding?.redis ? "server" : "unavailable",
  };
}
