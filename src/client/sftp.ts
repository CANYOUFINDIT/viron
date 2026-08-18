export interface SftpConnection {
  id: string;
  type: "ssh" | "local";
  name: string;
  host: string;
  port: number;
  username: string;
  environmentIds: string[];
  connectionGroupPath: string | null;
}

export const LOCAL_SFTP_CONNECTION_ID = "desktop-local";

export interface SftpOpenRequest {
  requestId: number;
  connectionId?: string;
  path: string;
}

export function createSftpOpenRequest(
  requestId: number,
  connectionId?: string,
  currentDirectory?: string,
): SftpOpenRequest {
  const normalizedConnectionId = connectionId?.trim() || undefined;
  const normalizedDirectory = currentDirectory?.trim();
  return {
    requestId,
    connectionId: normalizedConnectionId,
    path: normalizedDirectory?.startsWith("/") ? normalizedDirectory : "/",
  };
}

export function sftpOpenPathForConnection(
  request: SftpOpenRequest | undefined,
  connectionId: string | undefined,
): string {
  return request && request.connectionId === connectionId ? request.path : "/";
}

export function isLocalSftpConnection(connection: Pick<SftpConnection, "id" | "type"> | null | undefined): boolean {
  return connection?.type === "local" || connection?.id === LOCAL_SFTP_CONNECTION_ID;
}

export function groupSftpConnections(
  connections: SftpConnection[],
  environmentId: string | undefined,
  activeConnectionIds: ReadonlySet<string>,
): { recommended: SftpConnection[]; others: SftpConnection[] } {
  const sorted = [...connections].sort((left, right) => (
    Number(activeConnectionIds.has(right.id)) - Number(activeConnectionIds.has(left.id))
  ));
  if (!environmentId) return { recommended: [], others: sorted };
  return {
    recommended: sorted.filter((connection) => connection.environmentIds.includes(environmentId)),
    others: sorted.filter((connection) => !connection.environmentIds.includes(environmentId)),
  };
}

export interface SftpItem {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  targetType?: "directory" | "file" | null;
  size: number;
  mode: string;
  modifiedAt: string;
}

export function isSftpDirectory(item: SftpItem): boolean {
  return item.type === "directory" || (item.type === "symlink" && item.targetType === "directory");
}

export interface SftpPaneState {
  connectionId: string;
  path: string;
  selectedItems: SftpItem[];
}

export type SftpConflictDecision = "overwrite" | "skip";

export interface SftpTransferCreateInput {
  sourceConnectionId: string;
  targetConnectionId: string;
  sourcePath?: string;
  sourcePaths?: string[];
  targetDirectory: string;
  conflict: SftpConflictDecision;
  conflictDecisions?: Record<string, SftpConflictDecision>;
  originEnvironmentId?: string;
}

export function sftpTransferCreateSnapshot(input: SftpTransferCreateInput): SftpTransferCreateInput {
  return {
    ...input,
    sourcePaths: input.sourcePaths ? [...input.sourcePaths] : undefined,
    conflictDecisions: input.conflictDecisions ? { ...input.conflictDecisions } : undefined,
  };
}

export interface SftpTransferConflict {
  sourcePath: string;
  targetPath: string;
  sourceType: "file" | "directory";
  targetType: "file" | "directory" | "symlink";
}

export interface SftpTransferTask {
  id: string;
  sourceConnectionId: string;
  sourceConnectionName: string;
  sourcePath: string;
  sourcePaths: string[];
  targetConnectionId: string;
  targetConnectionName: string;
  targetPath: string;
  conflict: "overwrite" | "skip";
  status: "pending" | "running" | "success" | "error" | "cancelled";
  progress: number;
  transferredBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  completedFiles: number;
  skippedFiles: number;
  totalFiles: number;
  error: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
