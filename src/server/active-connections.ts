import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuthenticatedUser } from "./access-control.js";
import type { ActiveConnectionItem, ActiveConnectionType } from "../shared/active-connection.js";

const EXTERNAL_LEASE_MS = 60_000;
const TRAFFIC_WINDOW_MS = 5_000;
const TRAFFIC_BUCKET_MS = 250;

interface TrafficBucket {
  at: number;
  sentBytes: number;
  receivedBytes: number;
}

export class ConnectionLimitError extends Error {
  readonly code = "USER_CONNECTION_LIMIT";

  constructor(readonly limit: number) {
    super(`当前已达到单用户最大连接数 ${limit}，请先关闭现有连接再继续`);
  }
}

interface ResourceMetadata {
  label: string;
  environmentIds: string[];
  environmentNames: string[];
}

interface ManagedActiveConnection extends Omit<ActiveConnectionItem, "traffic" | "currentExecutionInstance"> {
  executionScope: string | null;
  external: boolean;
  externalHeartbeatSeen: boolean;
  leaseExpiresAt: number | null;
  lastActivityAtMs: number;
  closeRequestedReason: string;
  trafficBuckets: TrafficBucket[];
  sentBytes: number;
  receivedBytes: number;
  close?: (reason: string) => Promise<void> | void;
}

export interface ActiveConnectionReservation {
  id?: string;
  user: AuthenticatedUser;
  type: ActiveConnectionType;
  resourceId: string;
  originEnvironmentId?: string | null;
  relatedResourceId?: string;
  label?: string;
  executionScope?: string | null;
  client?: "web" | "desktop";
  executionMode?: "server" | "local";
  external?: boolean;
}

export interface ExternalConnectionHeartbeat {
  id: string;
  lastActivityAt: number;
}

function uniqueMetadata(rows: Array<{ id: string; name: string }>): Pick<ResourceMetadata, "environmentIds" | "environmentNames"> {
  const unique = new Map(rows.map((row) => [row.id, row.name]));
  return { environmentIds: [...unique.keys()], environmentNames: [...unique.values()] };
}

export class ActiveConnectionManager {
  private readonly entries = new Map<string, ManagedActiveConnection>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly app: FastifyInstance) {
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch((error) => this.app.log.error({ err: error }, "active connection cleanup failed"));
    }, 5_000);
    this.cleanupTimer.unref();
  }

  get limit(): number {
    return this.app.config.userConnectionLimit ?? 30;
  }

  get idleMinutes(): number {
    return this.app.config.connectionIdleMinutes ?? this.app.config.terminalIdleMinutes ?? 30;
  }

  async reserve(input: ActiveConnectionReservation): Promise<ActiveConnectionItem> {
    const id = input.id ?? randomUUID();
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.ownerId !== input.user.id) throw new Error("活动连接标识已被占用");
      return this.publicEntry(existing);
    }
    const metadata = await this.resourceMetadata(input.type, input.resourceId, input.relatedResourceId, input.label);
    const originEnvironmentId = input.originEnvironmentId
      ?? (["web", "logs"].includes(input.type) && metadata.environmentIds.length === 1 ? metadata.environmentIds[0] : null);
    if (this.activeCount(input.user.id) >= this.limit) throw new ConnectionLimitError(this.limit);
    const now = Date.now();
    const external = input.external === true;
    const entry: ManagedActiveConnection = {
      id,
      ownerId: input.user.id,
      ownerUsername: input.user.username,
      type: input.type,
      label: metadata.label,
      resourceId: input.resourceId,
      originEnvironmentId,
      environmentIds: metadata.environmentIds,
      environmentNames: metadata.environmentNames,
      workspaceType: input.user.workspace.type,
      workspaceId: input.user.workspace.id,
      workspaceName: input.user.workspace.name,
      client: input.client ?? (input.executionScope ? "desktop" : "web"),
      executionMode: input.executionMode ?? "server",
      createdAt: new Date(now).toISOString(),
      lastActivityAt: new Date(now).toISOString(),
      status: "active",
      executionScope: input.executionScope ?? null,
      external,
      externalHeartbeatSeen: false,
      leaseExpiresAt: external ? now + EXTERNAL_LEASE_MS : null,
      lastActivityAtMs: now,
      closeRequestedReason: "",
      trafficBuckets: [],
      sentBytes: 0,
      receivedBytes: 0,
    };
    this.entries.set(id, entry);
    return this.publicEntry(entry);
  }

  activate(id: string, close: (reason: string) => Promise<void> | void): void {
    const entry = this.entries.get(id);
    if (entry) entry.close = close;
  }

  touch(id: string, activityAt = Date.now()): void {
    const entry = this.entries.get(id);
    if (!entry || entry.closeRequestedReason) return;
    const normalized = Math.min(Date.now(), Math.max(entry.lastActivityAtMs, activityAt));
    entry.lastActivityAtMs = normalized;
    entry.lastActivityAt = new Date(normalized).toISOString();
  }

  touchResource(ownerId: string, type: ActiveConnectionType, resourceId: string, executionScope?: string | null): void {
    for (const entry of this.entries.values()) {
      if (entry.ownerId !== ownerId || entry.type !== type || entry.resourceId !== resourceId) continue;
      if (executionScope !== undefined && entry.executionScope !== executionScope) continue;
      this.touch(entry.id);
    }
  }

  recordTraffic(id: string, traffic: { sentBytes?: number; receivedBytes?: number }, activityAt = Date.now()): void {
    const entry = this.entries.get(id);
    if (!entry || entry.closeRequestedReason) return;
    const sentBytes = Math.max(0, Math.round(traffic.sentBytes ?? 0));
    const receivedBytes = Math.max(0, Math.round(traffic.receivedBytes ?? 0));
    if (!sentBytes && !receivedBytes) return;
    entry.sentBytes += sentBytes;
    entry.receivedBytes += receivedBytes;
    const last = entry.trafficBuckets.at(-1);
    if (last && activityAt - last.at < TRAFFIC_BUCKET_MS) {
      last.sentBytes += sentBytes;
      last.receivedBytes += receivedBytes;
    } else {
      entry.trafficBuckets.push({ at: activityAt, sentBytes, receivedBytes });
    }
    this.trimTraffic(entry, activityAt);
    this.touch(id, activityAt);
  }

  recordResourceTraffic(
    ownerId: string,
    type: ActiveConnectionType,
    resourceId: string,
    traffic: { sentBytes?: number; receivedBytes?: number },
    executionScope?: string | null,
  ): void {
    for (const entry of this.entries.values()) {
      if (entry.ownerId !== ownerId || entry.type !== type || entry.resourceId !== resourceId) continue;
      if (executionScope !== undefined && entry.executionScope !== executionScope) continue;
      this.recordTraffic(entry.id, traffic);
    }
  }

  release(id: string): void {
    this.entries.delete(id);
  }

  releaseExternal(id: string, ownerId: string, executionScope: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.external || entry.ownerId !== ownerId || entry.executionScope !== executionScope) return false;
    this.release(id);
    return true;
  }

  activeCount(ownerId: string): number {
    return [...this.entries.values()].filter((entry) => entry.ownerId === ownerId).length;
  }

  list(viewer: AuthenticatedUser, currentExecutionScope?: string | null): ActiveConnectionItem[] {
    return [...this.entries.values()]
      .filter((entry) => viewer.isPlatformAdmin || entry.ownerId === viewer.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((entry) => this.publicEntry(entry, currentExecutionScope));
  }

  get(id: string, viewer: AuthenticatedUser): ActiveConnectionItem | undefined {
    const entry = this.entries.get(id);
    if (!entry || (!viewer.isPlatformAdmin && entry.ownerId !== viewer.id)) return undefined;
    return this.publicEntry(entry);
  }

  getForExecutionScope(id: string, viewer: AuthenticatedUser, executionScope: string): ActiveConnectionItem | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.executionScope !== executionScope || (!viewer.isPlatformAdmin && entry.ownerId !== viewer.id)) return undefined;
    return this.publicEntry(entry, executionScope);
  }

  async closeForViewer(id: string, viewer: AuthenticatedUser, reason: string): Promise<ActiveConnectionItem | undefined> {
    const entry = this.entries.get(id);
    if (!entry || (!viewer.isPlatformAdmin && entry.ownerId !== viewer.id)) return undefined;
    const snapshot = this.publicEntry(entry);
    await this.requestClose(entry, reason);
    return snapshot;
  }

  async closeOwner(ownerId: string, reason: string): Promise<void> {
    await Promise.all([...this.entries.values()]
      .filter((entry) => entry.ownerId === ownerId)
      .map((entry) => this.requestClose(entry, reason)));
  }

  syncExternal(ownerId: string, executionScope: string, heartbeats: ExternalConnectionHeartbeat[]): Array<{ id: string; reason: string }> {
    const now = Date.now();
    const activeIds = new Set(heartbeats.map((item) => item.id));
    for (const entry of this.entries.values()) {
      if (!entry.external || entry.ownerId !== ownerId || entry.executionScope !== executionScope) continue;
      if (!activeIds.has(entry.id)) {
        if (entry.externalHeartbeatSeen) this.release(entry.id);
        continue;
      }
      entry.externalHeartbeatSeen = true;
      entry.leaseExpiresAt = now + EXTERNAL_LEASE_MS;
    }
    for (const heartbeat of heartbeats) {
      const entry = this.entries.get(heartbeat.id);
      if (entry?.external && entry.ownerId === ownerId && entry.executionScope === executionScope) {
        this.touch(heartbeat.id, heartbeat.lastActivityAt);
      }
    }
    return [...this.entries.values()]
      .filter((entry) => entry.external && entry.ownerId === ownerId && entry.executionScope === executionScope && entry.closeRequestedReason)
      .map((entry) => ({ id: entry.id, reason: entry.closeRequestedReason }));
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
    this.entries.clear();
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    const idleCutoff = now - this.idleMinutes * 60_000;
    for (const entry of [...this.entries.values()]) {
      if (entry.external && entry.leaseExpiresAt !== null && entry.leaseExpiresAt < now) {
        this.release(entry.id);
        continue;
      }
      if (entry.type === "database" && this.app.databaseQueries?.hasActive(entry.ownerId, entry.resourceId, entry.executionScope)) {
        this.touch(entry.id);
        continue;
      }
      if (!entry.closeRequestedReason && entry.lastActivityAtMs < idleCutoff) {
        await this.requestClose(entry, `空闲超过 ${this.idleMinutes} 分钟`);
      }
    }
  }

  private async requestClose(entry: ManagedActiveConnection, reason: string): Promise<void> {
    if (!this.entries.has(entry.id) || entry.closeRequestedReason) return;
    entry.closeRequestedReason = reason;
    entry.status = "closing";
    if (entry.external) return;
    if (entry.close) await entry.close(reason);
    this.release(entry.id);
  }

  private publicEntry(entry: ManagedActiveConnection, currentExecutionScope?: string | null): ActiveConnectionItem {
    const now = Date.now();
    this.trimTraffic(entry, now);
    const traffic = entry.trafficBuckets.reduce(
      (total, bucket) => ({
        sentBytes: total.sentBytes + bucket.sentBytes,
        receivedBytes: total.receivedBytes + bucket.receivedBytes,
      }),
      { sentBytes: 0, receivedBytes: 0 },
    );
    const oldest = entry.trafficBuckets[0]?.at ?? now;
    const elapsedSeconds = Math.max(1, Math.min(TRAFFIC_WINDOW_MS, now - oldest + TRAFFIC_BUCKET_MS) / 1000);
    const { executionScope: _executionScope, external: _external, externalHeartbeatSeen: _externalHeartbeatSeen, leaseExpiresAt: _leaseExpiresAt,
      lastActivityAtMs: _lastActivityAtMs, closeRequestedReason: _closeRequestedReason,
      trafficBuckets: _trafficBuckets, sentBytes, receivedBytes, close: _close, ...result } = entry;
    return {
      ...result,
      currentExecutionInstance: Boolean(currentExecutionScope && entry.executionScope === currentExecutionScope),
      traffic: {
        sentBytesPerSecond: Math.round(traffic.sentBytes / elapsedSeconds),
        receivedBytesPerSecond: Math.round(traffic.receivedBytes / elapsedSeconds),
        sentBytes,
        receivedBytes,
      },
    };
  }

  private trimTraffic(entry: ManagedActiveConnection, now: number): void {
    const cutoff = now - TRAFFIC_WINDOW_MS;
    while (entry.trafficBuckets[0]?.at < cutoff) entry.trafficBuckets.shift();
  }

  private async resourceMetadata(type: ActiveConnectionType, resourceId: string, relatedResourceId?: string, providedLabel?: string): Promise<ResourceMetadata> {
    if (type === "web") {
      const resource = await this.app.db.prepare(`
        SELECT c.username, w.name FROM web_credentials c
        JOIN web_entries w ON w.id = c.web_entry_id WHERE c.id = ?
      `).get(resourceId) as { username: string; name: string } | undefined;
      const rows = await this.app.db.prepare(`
        SELECT e.id, e.name FROM web_credentials c
        JOIN web_entries w ON w.id = c.web_entry_id
        JOIN environments e ON e.id = w.environment_id WHERE c.id = ?
      `).all(resourceId) as Array<{ id: string; name: string }>;
      return { label: providedLabel || (resource ? `${resource.name} · ${resource.username}` : "Web 页面"), ...uniqueMetadata(rows) };
    }
    if (type === "logs") {
      const resource = await this.app.db.prepare(`
        SELECT l.name, e.id AS environment_id, e.name AS environment_name
        FROM environment_logs l JOIN environments e ON e.id = l.environment_id WHERE l.id = ?
      `).get(resourceId) as { name: string; environment_id: string; environment_name: string } | undefined;
      const rows = resource ? [{ id: resource.environment_id, name: resource.environment_name }] : [];
      return { label: providedLabel || resource?.name || "实时日志", ...uniqueMetadata(rows) };
    }
    const table = type === "database" ? "database_connections" : type === "redis" ? "redis_connections" : "ssh_connections";
    const joinTable = type === "database" ? "database_connection_environments" : type === "redis" ? "redis_connection_environments" : "ssh_connection_environments";
    const resource = await this.app.db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(resourceId) as { name: string } | undefined;
    const rows = await this.app.db.prepare(`
      SELECT e.id, e.name FROM ${joinTable} ce JOIN environments e ON e.id = ce.environment_id WHERE ce.connection_id = ?
    `).all(resourceId) as Array<{ id: string; name: string }>;
    let label = providedLabel || resource?.name || (type === "database" ? "数据库连接" : type === "redis" ? "Redis 连接" : "SSH 连接");
    if (type === "sftp" && relatedResourceId) {
      const related = await this.app.db.prepare("SELECT name FROM ssh_connections WHERE id = ?").get(relatedResourceId) as { name: string } | undefined;
      const relatedRows = await this.app.db.prepare(`
        SELECT e.id, e.name FROM ssh_connection_environments ce JOIN environments e ON e.id = ce.environment_id WHERE ce.connection_id = ?
      `).all(relatedResourceId) as Array<{ id: string; name: string }>;
      rows.push(...relatedRows);
      if (!providedLabel && related?.name) label = `${label} → ${related.name}`;
    }
    return { label, ...uniqueMetadata(rows) };
  }
}
