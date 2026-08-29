import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  defaultMonitorAlertSettings,
  monitorDiskKey,
  type MonitorAlertRuleType,
  type MonitorAlertSettings,
  type MonitorAlertTargetType,
} from "../shared/monitor-alerts.js";
import { DEFAULT_TLS_WARN_DAYS, TLS_WARN_DAYS, tlsDaysRemaining } from "../shared/tls-certificates.js";
import type { MonitorCandidate, MonitorHostSnapshot } from "./service-monitor.js";

interface MonitorAlertSettingsRow {
  enabled: number | string;
  host_offline_enabled: number | string;
  cpu_enabled: number | string;
  cpu_threshold: number | string;
  memory_enabled: number | string;
  memory_threshold: number | string;
  disk_usage_enabled: number | string;
  disk_usage_threshold: number | string;
  temperature_enabled: number | string;
  temperature_threshold: number | string;
  deployment_status_enabled: number | string;
  disk_missing_enabled: number | string;
  tls_enabled?: number | string;
  tls_warn_days?: number | string;
  tls_hostname_mismatch_enabled?: number | string;
  excluded_disks_json: string;
}

interface MonitorAlertEnvironment {
  id: string;
  name: string;
  sshConnectionId: string;
  connectionName: string;
  settings: MonitorAlertSettings;
}

interface MonitorAlertDeployment {
  id: string;
  serviceId: string;
  serviceName: string;
  sshConnectionId: string | null;
  connectionName: string;
  provider: string;
  externalId: string;
  displayName: string;
}

interface MonitorAlertObservation {
  targetType: MonitorAlertTargetType;
  targetId: string;
  ruleType: MonitorAlertRuleType;
  ruleKey: string;
  sshConnectionId: string | null;
  serviceId: string | null;
  deploymentId: string | null;
  targetName: string;
  connectionName: string;
  serviceName: string;
  breached: boolean | null;
  details: Record<string, unknown>;
  event?: boolean;
}

interface MonitorAlertStateRow {
  id: string;
  target_type: MonitorAlertTargetType;
  target_id: string;
  rule_type: MonitorAlertRuleType;
  rule_key_hash: string;
  rule_key: string;
  ssh_connection_id: string | null;
  target_name: string;
  connection_name: string;
  breach_count: number | string;
  recovery_count: number | string;
  active_alert_id: string | null;
  last_evaluated_at: string;
}

const diskBaselineRuleKey = "__viron_disk_mount_baseline__";

export interface MonitorAlertSample {
  collectedAt: string;
  host: MonitorHostSnapshot;
  candidates: MonitorCandidate[];
}

function parseExcludedDisks(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 512) : [];
  } catch {
    return [];
  }
}

export function monitorAlertSettingsFromRow(row?: MonitorAlertSettingsRow | null): MonitorAlertSettings {
  if (!row) return { ...defaultMonitorAlertSettings, excludedDisks: [] };
  return {
    enabled: Boolean(Number(row.enabled)),
    hostOfflineEnabled: Boolean(Number(row.host_offline_enabled)),
    cpuEnabled: Boolean(Number(row.cpu_enabled)),
    cpuThreshold: Number(row.cpu_threshold),
    memoryEnabled: Boolean(Number(row.memory_enabled)),
    memoryThreshold: Number(row.memory_threshold),
    diskUsageEnabled: Boolean(Number(row.disk_usage_enabled)),
    diskUsageThreshold: Number(row.disk_usage_threshold),
    temperatureEnabled: Boolean(Number(row.temperature_enabled)),
    temperatureThreshold: Number(row.temperature_threshold),
    deploymentStatusEnabled: Boolean(Number(row.deployment_status_enabled)),
    diskMissingEnabled: Boolean(Number(row.disk_missing_enabled)),
    tlsEnabled: row.tls_enabled == null ? true : Boolean(Number(row.tls_enabled)),
    tlsWarnDays: TLS_WARN_DAYS.includes(Number(row.tls_warn_days) as typeof TLS_WARN_DAYS[number])
      ? Number(row.tls_warn_days)
      : DEFAULT_TLS_WARN_DAYS,
    tlsHostnameMismatchEnabled: row.tls_hostname_mismatch_enabled == null ? true : Boolean(Number(row.tls_hostname_mismatch_enabled)),
    excludedDisks: parseExcludedDisks(row.excluded_disks_json),
    consecutiveSamples: 2,
  };
}

export async function monitorAlertSettingsForEnvironment(app: FastifyInstance, environmentId: string): Promise<MonitorAlertSettings> {
  const row = await app.db.prepare("SELECT * FROM monitor_alert_settings WHERE environment_id = ?").get(environmentId) as MonitorAlertSettingsRow | undefined;
  return monitorAlertSettingsFromRow(row);
}

function stateKey(targetType: string, targetId: string, ruleType: string, ruleKeyHash: string): string {
  return `${targetType}\0${targetId}\0${ruleType}\0${ruleKeyHash}`;
}

function ruleKeyHash(ruleKey: string): string {
  return createHash("sha256").update(ruleKey).digest("hex");
}

function thresholdObservation(
  target: Omit<MonitorAlertObservation, "ruleType" | "ruleKey" | "breached" | "details">,
  ruleType: "cpu" | "memory" | "temperature",
  value: number,
  threshold: number,
): MonitorAlertObservation {
  return { ...target, ruleType, ruleKey: "", breached: Number.isFinite(value) ? value >= threshold : null, details: { value, threshold } };
}

function diskDetails(disk: MonitorHostSnapshot["disks"][number], extra: Record<string, unknown> = {}) {
  return {
    path: disk.path,
    device: disk.device ?? "",
    filesystem: disk.filesystem ?? "",
    ...extra,
  };
}

function missingDiskDetails(ruleKey: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(ruleKey);
    if (Array.isArray(parsed) && parsed.length === 2) {
      return { missing: true, device: String(parsed[0] ?? ""), path: String(parsed[1] ?? "") };
    }
  } catch {
    // Preserve the opaque identity when an old rule key is not JSON encoded.
  }
  return { missing: true, diskKey: ruleKey };
}

async function monitoredEnvironments(
  app: FastifyInstance,
  agentId: string,
  workspaceType: string,
  workspaceId: string,
): Promise<MonitorAlertEnvironment[]> {
  const rows = await app.db.prepare(`
    SELECT e.id, e.name, c.id AS ssh_connection_id, c.name AS connection_name,
      s.enabled, s.host_offline_enabled, s.cpu_enabled, s.cpu_threshold, s.memory_enabled, s.memory_threshold,
      s.disk_usage_enabled, s.disk_usage_threshold, s.temperature_enabled, s.temperature_threshold,
      s.deployment_status_enabled, s.disk_missing_enabled,
      s.tls_enabled, s.tls_warn_days, s.tls_hostname_mismatch_enabled, s.excluded_disks_json,
      h.install_managed, h.status, h.last_collected_at, ce.maintenance_sort_order
    FROM environments e
    JOIN ssh_connection_environments ce ON ce.environment_id = e.id
    JOIN ssh_connections c ON c.id = ce.connection_id
    JOIN monitor_hosts h ON h.ssh_connection_id = c.id
    LEFT JOIN monitor_alert_settings s ON s.environment_id = e.id
    WHERE e.workspace_type = ? AND e.workspace_id = ? AND h.agent_id = ?
    ORDER BY e.id, h.install_managed DESC,
      CASE WHEN h.status = 'ready' THEN 0 ELSE 1 END,
      COALESCE(h.last_collected_at, '') DESC, ce.maintenance_sort_order, c.id
  `).all(workspaceType, workspaceId, agentId) as Array<Record<string, unknown>>;
  const environments = new Map<string, MonitorAlertEnvironment>();
  for (const row of rows) {
    const environmentId = String(row.id);
    if (environments.has(environmentId)) continue;
    environments.set(environmentId, {
      id: environmentId,
      name: String(row.name),
      sshConnectionId: String(row.ssh_connection_id),
      connectionName: String(row.connection_name),
      settings: monitorAlertSettingsFromRow(row.enabled == null ? null : row as unknown as MonitorAlertSettingsRow),
    });
  }
  return [...environments.values()].filter((environment) => environment.settings.enabled);
}

async function environmentDeployments(app: FastifyInstance, environmentId: string, agentId: string): Promise<MonitorAlertDeployment[]> {
  const rows = await app.db.prepare(`
    SELECT d.id, d.ssh_connection_id, d.ssh_connection_name, d.provider_type, d.external_id, d.display_name,
      s.id AS service_id, s.name AS service_name
    FROM service_deployments d
    JOIN services s ON s.id = d.service_id
    JOIN monitor_hosts h ON h.ssh_connection_id = d.ssh_connection_id
    WHERE s.environment_id = ? AND s.status = 'active' AND h.agent_id = ?
    ORDER BY s.sort_order, d.created_at, d.id
  `).all(environmentId, agentId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    serviceId: String(row.service_id),
    serviceName: String(row.service_name),
    sshConnectionId: row.ssh_connection_id ? String(row.ssh_connection_id) : null,
    connectionName: String(row.ssh_connection_name ?? ""),
    provider: String(row.provider_type),
    externalId: String(row.external_id),
    displayName: String(row.display_name ?? ""),
  }));
}

function hostObservations(environment: MonitorAlertEnvironment, agentId: string, host: MonitorHostSnapshot): MonitorAlertObservation[] {
  const settings = environment.settings;
  const target = {
    targetType: "host" as const,
    targetId: agentId,
    sshConnectionId: environment.sshConnectionId,
    serviceId: null,
    deploymentId: null,
    targetName: host.hostname || environment.connectionName,
    connectionName: environment.connectionName,
    serviceName: "",
  };
  const observations: MonitorAlertObservation[] = [];
  if (settings.cpuEnabled) observations.push(thresholdObservation(target, "cpu", host.cpuUsedPercent, settings.cpuThreshold));
  if (settings.memoryEnabled) observations.push(thresholdObservation(target, "memory", host.memoryUsedPercent, settings.memoryThreshold));
  if (settings.temperatureEnabled && host.temperatures.length) {
    const temperature = host.temperatures.reduce((current, item) => item.celsius > current.celsius ? item : current);
    observations.push({
      ...thresholdObservation(target, "temperature", temperature.celsius, settings.temperatureThreshold),
      details: { value: temperature.celsius, threshold: settings.temperatureThreshold, chip: temperature.chip, feature: temperature.feature ?? "" },
    });
  }
  const excluded = new Set(settings.excludedDisks);
  if (settings.diskMissingEnabled) {
    observations.push({ ...target, ruleType: "disk_missing", ruleKey: diskBaselineRuleKey, breached: false, details: { baseline: true } });
  }
  for (const disk of host.disks) {
    const key = monitorDiskKey(disk);
    if (excluded.has(key)) continue;
    if (settings.diskUsageEnabled) {
      observations.push({
        ...target,
        ruleType: "disk_usage",
        ruleKey: key,
        breached: Number.isFinite(disk.usedPercent) ? disk.usedPercent >= settings.diskUsageThreshold : null,
        details: diskDetails(disk, { value: disk.usedPercent, threshold: settings.diskUsageThreshold }),
      });
    }
    if (settings.diskMissingEnabled) {
      observations.push({ ...target, ruleType: "disk_missing", ruleKey: key, breached: false, details: diskDetails(disk) });
    }
  }
  return observations;
}

function deploymentObservations(
  environment: MonitorAlertEnvironment,
  deployments: MonitorAlertDeployment[],
  candidates: MonitorCandidate[],
): MonitorAlertObservation[] {
  if (!environment.settings.deploymentStatusEnabled) return [];
  const candidatesByTarget = new Map(candidates.map((candidate) => [`${candidate.provider}:${candidate.externalId}`, candidate]));
  return deployments.map((deployment) => {
    const candidate = candidatesByTarget.get(`${deployment.provider}:${deployment.externalId}`);
    const status = candidate?.status ?? "unknown";
    return {
      targetType: "deployment" as const,
      targetId: deployment.id,
      ruleType: "deployment_status" as const,
      ruleKey: "",
      sshConnectionId: deployment.sshConnectionId,
      serviceId: deployment.serviceId,
      deploymentId: deployment.id,
      targetName: deployment.displayName || deployment.externalId,
      connectionName: deployment.connectionName,
      serviceName: deployment.serviceName,
      breached: status === "stopped" || status === "degraded" ? true : status === "running" ? false : null,
      details: { status, state: candidate?.state ?? "", provider: deployment.provider, externalId: deployment.externalId },
    };
  });
}

async function applyObservations(
  app: FastifyInstance,
  environment: MonitorAlertEnvironment,
  observations: MonitorAlertObservation[],
  evaluatedAt: string,
  observedHostTargetIds: ReadonlySet<string>,
): Promise<void> {
  const stateRows = await app.db.prepare("SELECT * FROM monitor_alert_states WHERE environment_id = ?").all(environment.id) as MonitorAlertStateRow[];
  const states = new Map(stateRows.map((state) => [stateKey(state.target_type, state.target_id, state.rule_type, state.rule_key_hash), state]));
  const diskObservations = observations.filter((item) => item.ruleType === "disk_missing" && item.ruleKey !== diskBaselineRuleKey);
  const currentDiskStateKeys = new Set(diskObservations.map((item) => stateKey(
    item.targetType,
    item.targetId,
    "disk_missing",
    ruleKeyHash(item.ruleKey),
  )));
  const excludedDisks = new Set(environment.settings.excludedDisks);
  const baselineTargets = new Set(stateRows.filter((state) => state.rule_type === "disk_missing" && state.rule_key === diskBaselineRuleKey).map((state) => state.target_id));
  const suppressedNewDiskStates = new Set<string>();
  for (const observation of diskObservations) {
    const missingKey = stateKey(observation.targetType, observation.targetId, "disk_missing", ruleKeyHash(observation.ruleKey));
    const addedKey = stateKey(observation.targetType, observation.targetId, "disk_added", ruleKeyHash(observation.ruleKey));
    const missingState = states.get(missingKey);
    const addedState = states.get(addedKey);
    if (baselineTargets.has(observation.targetId) && !missingState && !addedState?.active_alert_id) {
      suppressedNewDiskStates.add(missingKey);
    }
    if (!addedState && (!baselineTargets.has(observation.targetId) || missingState)) continue;
    observations.push({
      ...observation,
      ruleType: "disk_added",
      breached: true,
      event: true,
      details: { ...observation.details, added: true },
    });
  }
  for (const state of stateRows) {
    if (state.target_type !== "host" || state.rule_type !== "disk_added" || !state.active_alert_id || !observedHostTargetIds.has(state.target_id)) continue;
    const missingKey = stateKey(state.target_type, state.target_id, "disk_missing", state.rule_key_hash);
    if (currentDiskStateKeys.has(missingKey) || states.has(missingKey) || excludedDisks.has(state.rule_key)) continue;
    observations.push({
      targetType: "host",
      targetId: state.target_id,
      ruleType: "disk_missing",
      ruleKey: state.rule_key,
      sshConnectionId: state.ssh_connection_id,
      serviceId: null,
      deploymentId: null,
      targetName: state.target_name,
      connectionName: state.connection_name,
      serviceName: "",
      breached: true,
      details: missingDiskDetails(state.rule_key),
    });
  }
  for (const state of stateRows) {
    if (state.rule_key === diskBaselineRuleKey) continue;
    const currentKey = stateKey(state.target_type, state.target_id, "disk_missing", state.rule_key_hash);
    if (state.target_type !== "host" || !observedHostTargetIds.has(state.target_id) || state.rule_type !== "disk_missing" || currentDiskStateKeys.has(currentKey)) continue;
    if (excludedDisks.has(state.rule_key)) continue;
    observations.push({
      targetType: "host",
      targetId: state.target_id,
      ruleType: "disk_missing",
      ruleKey: state.rule_key,
      sshConnectionId: state.ssh_connection_id,
      serviceId: null,
      deploymentId: null,
      targetName: state.target_name,
      connectionName: state.connection_name,
      serviceName: "",
      breached: true,
      details: missingDiskDetails(state.rule_key),
    });
  }

  const now = new Date().toISOString();
  await app.db.transaction(async () => {
    for (const state of stateRows) {
      if (state.target_type !== "host" || state.rule_type !== "disk_added" || !observedHostTargetIds.has(state.target_id) || state.active_alert_id) continue;
      const currentKey = stateKey(state.target_type, state.target_id, "disk_missing", state.rule_key_hash);
      if (currentDiskStateKeys.has(currentKey) || Number(state.breach_count) === 0) continue;
      await app.db.prepare(`
        UPDATE monitor_alert_states SET breach_count = 0, recovery_count = 0,
          last_evaluated_at = ?, updated_at = ? WHERE id = ?
      `).run(evaluatedAt, now, state.id);
      state.breach_count = 0;
      state.recovery_count = 0;
      state.last_evaluated_at = evaluatedAt;
    }
    for (const observation of observations) {
      if (observation.ruleType === "disk_missing") {
        const missingKey = stateKey(observation.targetType, observation.targetId, "disk_missing", ruleKeyHash(observation.ruleKey));
        if (suppressedNewDiskStates.has(missingKey)) continue;
      }
      const hash = ruleKeyHash(observation.ruleKey);
      const key = stateKey(observation.targetType, observation.targetId, observation.ruleType, hash);
      let state = states.get(key);
      if (state && Date.parse(state.last_evaluated_at) >= Date.parse(evaluatedAt)) continue;
      if (!state) {
        const id = randomUUID();
        await app.db.prepare(`
          INSERT INTO monitor_alert_states (
            id, environment_id, target_type, target_id, rule_type, rule_key_hash, rule_key,
            ssh_connection_id, service_id, deployment_id, target_name, connection_name, service_name,
            breach_count, recovery_count, active_alert_id, last_value_json, last_evaluated_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)
        `).run(
          id, environment.id, observation.targetType, observation.targetId, observation.ruleType, hash, observation.ruleKey,
          observation.sshConnectionId, observation.serviceId, observation.deploymentId, observation.targetName,
          observation.connectionName, observation.serviceName, observation.breached === true ? 1 : 0,
          JSON.stringify(observation.details), evaluatedAt, now, now,
        );
        state = {
          id,
          target_type: observation.targetType,
          target_id: observation.targetId,
          rule_type: observation.ruleType,
          rule_key_hash: hash,
          rule_key: observation.ruleKey,
          ssh_connection_id: observation.sshConnectionId,
          target_name: observation.targetName,
          connection_name: observation.connectionName,
          breach_count: observation.breached === true ? 1 : 0,
          recovery_count: 0,
          active_alert_id: null,
          last_evaluated_at: evaluatedAt,
        };
        states.set(key, state as MonitorAlertStateRow);
        continue;
      }
      if (observation.breached === null) {
        await app.db.prepare(`
          UPDATE monitor_alert_states SET ssh_connection_id = ?, service_id = ?, deployment_id = ?,
            target_name = ?, connection_name = ?, service_name = ?, last_value_json = ?,
            last_evaluated_at = ?, updated_at = ? WHERE id = ?
        `).run(
          observation.sshConnectionId, observation.serviceId, observation.deploymentId, observation.targetName,
          observation.connectionName, observation.serviceName, JSON.stringify(observation.details), evaluatedAt, now, state.id,
        );
        continue;
      }
      const activeAlertId = state.active_alert_id || null;
      let breachCount = Number(state.breach_count);
      let recoveryCount = Number(state.recovery_count);
      if (observation.breached) {
        recoveryCount = 0;
        if (!activeAlertId) breachCount += 1;
        if (!activeAlertId && breachCount >= environment.settings.consecutiveSamples) {
          const alertId = randomUUID();
          const alertStatus = observation.event ? "event" : "active";
          await app.db.prepare(`
            INSERT INTO monitor_alerts (
              id, environment_id, state_id, target_type, target_id, rule_type, rule_key,
              ssh_connection_id, service_id, deployment_id, environment_name, target_name,
              connection_name, service_name, status, details_json, triggered_at, recovered_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          `).run(
            alertId, environment.id, state.id, observation.targetType, observation.targetId, observation.ruleType,
            observation.ruleKey, observation.sshConnectionId, observation.serviceId, observation.deploymentId,
            environment.name, observation.targetName, observation.connectionName, observation.serviceName,
            alertStatus, JSON.stringify(observation.details), evaluatedAt, now, now,
          );
          state.active_alert_id = alertId;
        }
      } else {
        breachCount = 0;
        if (activeAlertId) {
          recoveryCount += 1;
          if (recoveryCount >= environment.settings.consecutiveSamples) {
            const recoveryDetails = observation.ruleType === "disk_missing"
              ? { ...observation.details, recovered: true }
              : observation.details;
            await app.db.prepare(`
              UPDATE monitor_alerts SET status = 'recovered', details_json = ?, recovered_at = ?, updated_at = ?
              WHERE id = ? AND status = 'active'
            `).run(JSON.stringify(recoveryDetails), evaluatedAt, now, activeAlertId);
            state.active_alert_id = null;
            recoveryCount = 0;
          }
        } else recoveryCount = 0;
      }
      await app.db.prepare(`
        UPDATE monitor_alert_states SET ssh_connection_id = ?, service_id = ?, deployment_id = ?,
          target_name = ?, connection_name = ?, service_name = ?, breach_count = ?, recovery_count = ?,
          active_alert_id = ?, last_value_json = ?, last_evaluated_at = ?, updated_at = ? WHERE id = ?
      `).run(
        observation.sshConnectionId, observation.serviceId, observation.deploymentId, observation.targetName,
        observation.connectionName, observation.serviceName, breachCount, recoveryCount, state.active_alert_id,
        JSON.stringify(observation.details), evaluatedAt, now, state.id,
      );
      state.breach_count = breachCount;
      state.recovery_count = recoveryCount;
      state.last_evaluated_at = evaluatedAt;
    }
  })();
}

export interface MonitorHostAvailabilityInput {
  connectionId: string;
  checkedAt: string;
  available: boolean;
  status: "ready" | "missing" | "error";
  reason: "healthy" | "pull_failed" | "monitor_missing" | "sample_stale" | "no_samples";
  error?: string;
  hostname?: string;
  lastCollectedAt?: string | null;
  sampleResolutionSeconds?: number | null;
}

function storedHostname(value: string): string {
  try {
    const parsed = JSON.parse(value) as { hostname?: unknown };
    return typeof parsed?.hostname === "string" ? parsed.hostname.trim() : "";
  } catch {
    return "";
  }
}

export async function evaluateMonitorHostAvailability(
  app: FastifyInstance,
  input: MonitorHostAvailabilityInput,
): Promise<void> {
  const row = await app.db.prepare(`
    SELECT h.agent_id, h.latest_host_json, h.last_collected_at, c.workspace_type, c.workspace_id
    FROM monitor_hosts h JOIN ssh_connections c ON c.id = h.ssh_connection_id
    WHERE h.ssh_connection_id = ?
  `).get(input.connectionId) as {
    agent_id: string;
    latest_host_json: string;
    last_collected_at: string | null;
    workspace_type: string;
    workspace_id: string;
  } | undefined;
  if (!row?.agent_id) return;

  const environments = await monitoredEnvironments(app, row.agent_id, row.workspace_type, row.workspace_id);
  const hostname = input.hostname?.trim() || storedHostname(row.latest_host_json);
  for (const environment of environments) {
    if (!environment.settings.hostOfflineEnabled) continue;
    const observation: MonitorAlertObservation = {
      targetType: "host",
      targetId: row.agent_id,
      ruleType: "host_offline",
      ruleKey: "",
      sshConnectionId: environment.sshConnectionId,
      serviceId: null,
      deploymentId: null,
      targetName: hostname || environment.connectionName,
      connectionName: environment.connectionName,
      serviceName: "",
      breached: !input.available,
      details: {
        available: input.available,
        status: input.status,
        reason: input.reason,
        lastError: input.error?.slice(0, 500) ?? "",
        lastCollectedAt: input.lastCollectedAt ?? row.last_collected_at ?? null,
        sampleResolutionSeconds: input.sampleResolutionSeconds ?? null,
      },
    };
    await applyObservations(app, environment, [observation], input.checkedAt, new Set());
  }
}

export async function evaluateMonitorAlertSamples(
  app: FastifyInstance,
  input: {
    agentId: string;
    workspaceType: string;
    workspaceId: string;
    samples: MonitorAlertSample[];
  },
): Promise<void> {
  if (!input.samples.length) return;
  const environments = await monitoredEnvironments(app, input.agentId, input.workspaceType, input.workspaceId);
  for (const environment of environments) {
    const deployments = await environmentDeployments(app, environment.id, input.agentId);
    for (const sample of input.samples) {
      const observations = [
        ...hostObservations(environment, input.agentId, sample.host),
        ...deploymentObservations(environment, deployments, sample.candidates),
      ];
      await applyObservations(app, environment, observations, sample.collectedAt, new Set([input.agentId]));
    }
  }
}

export async function evaluateRecentMonitorAlerts(
  app: FastifyInstance,
  agentId: string,
  workspaceType: string,
  workspaceId: string,
): Promise<void> {
  const connection = await app.db.prepare(`
    SELECT h.ssh_connection_id, h.latest_host_json, h.latest_candidates_json, h.last_collected_at
    FROM monitor_hosts h
    JOIN ssh_connections c ON c.id = h.ssh_connection_id
    WHERE h.agent_id = ? AND c.workspace_type = ? AND c.workspace_id = ?
    ORDER BY h.install_managed DESC,
      CASE WHEN h.status = 'ready' THEN 0 ELSE 1 END,
      COALESCE(h.last_collected_at, '') DESC,
      h.ssh_connection_id
    LIMIT 1
  `).get(agentId, workspaceType, workspaceId) as
    | { ssh_connection_id: string; latest_host_json: string; latest_candidates_json: string; last_collected_at: string | null }
    | undefined;
  if (!connection) return;
  const rows = await app.db.prepare(`
    SELECT payload_json
    FROM monitor_samples
    WHERE ssh_connection_id = ? AND agent_id = ?
    ORDER BY collected_at DESC, sequence_end DESC
    LIMIT 8
  `).all(connection.ssh_connection_id, agentId) as Array<{ payload_json: string }>;
  const samples: MonitorAlertSample[] = [];
  for (const row of rows.reverse()) {
    try {
      const payload = JSON.parse(row.payload_json) as MonitorAlertSample;
      if (payload?.host && Array.isArray(payload.candidates) && typeof payload.collectedAt === "string") samples.push(payload);
    } catch {
      // Invalid legacy samples cannot participate in alert evaluation.
    }
  }
  if (!samples.length && connection.last_collected_at) {
    try {
      const host = JSON.parse(connection.latest_host_json) as MonitorHostSnapshot;
      const candidates = JSON.parse(connection.latest_candidates_json) as MonitorCandidate[];
      if (host && typeof host.hostname === "string") {
        samples.push({
          collectedAt: connection.last_collected_at,
          host,
          candidates: Array.isArray(candidates) ? candidates : [],
        });
      }
    } catch {
      // Invalid retained snapshots cannot participate in alert evaluation.
    }
  }
  await evaluateMonitorAlertSamples(app, { agentId, workspaceType, workspaceId, samples });
}

export async function evaluateTlsEndpointAlerts(app: FastifyInstance, environmentId: string): Promise<void> {
  const row = await app.db.prepare(`
    SELECT e.id, e.name, s.enabled, s.host_offline_enabled, s.cpu_enabled, s.cpu_threshold, s.memory_enabled, s.memory_threshold,
      s.disk_usage_enabled, s.disk_usage_threshold, s.temperature_enabled, s.temperature_threshold,
      s.deployment_status_enabled, s.disk_missing_enabled, s.tls_enabled, s.tls_warn_days,
      s.tls_hostname_mismatch_enabled, s.excluded_disks_json
    FROM environments e
    LEFT JOIN monitor_alert_settings s ON s.environment_id = e.id
    WHERE e.id = ?
  `).get(environmentId) as (MonitorAlertSettingsRow & { id: string; name: string }) | undefined;
  if (!row) return;
  const settings = monitorAlertSettingsFromRow(row.enabled == null ? null : row);
  if (!settings.tlsEnabled) return;
  const endpoints = await app.db.prepare(`
    SELECT e.id, e.host, e.port, e.sni, e.ssh_connection_id, e.leaf_cn, e.not_after, e.days_remaining,
      e.hostname_match, e.fingerprint_sha256, c.name AS connection_name
    FROM tls_endpoints e
    LEFT JOIN ssh_connections c ON c.id = e.ssh_connection_id
    WHERE e.environment_id = ? AND e.observe_enabled = 1
  `).all(environmentId) as Array<{
    id: string;
    host: string;
    port: number | string;
    sni: string;
    ssh_connection_id: string | null;
    leaf_cn: string;
    not_after: string | null;
    days_remaining: number | string | null;
    hostname_match: number | string | null;
    fingerprint_sha256: string;
    connection_name: string | null;
  }>;
  const now = new Date().toISOString();
  const observations: MonitorAlertObservation[] = [];
  for (const endpoint of endpoints) {
    if (!endpoint.fingerprint_sha256 || !endpoint.not_after) continue;
    const daysRemaining = endpoint.days_remaining == null ? tlsDaysRemaining(endpoint.not_after) : Number(endpoint.days_remaining);
    const target = {
      targetType: "tls_endpoint" as const,
      targetId: endpoint.id,
      sshConnectionId: endpoint.ssh_connection_id,
      serviceId: null,
      deploymentId: null,
      targetName: endpoint.leaf_cn || endpoint.sni || endpoint.host,
      connectionName: endpoint.connection_name || `${endpoint.host}:${endpoint.port}`,
      serviceName: "",
    };
    const details = {
      host: endpoint.host,
      port: Number(endpoint.port),
      sni: endpoint.sni,
      fingerprint: endpoint.fingerprint_sha256,
      daysRemaining,
      notAfter: endpoint.not_after,
      threshold: settings.tlsWarnDays,
    };
    observations.push({
      ...target,
      ruleType: "tls_expired",
      ruleKey: "",
      breached: daysRemaining != null && daysRemaining < 0,
      details,
    });
    observations.push({
      ...target,
      ruleType: "tls_expiring",
      ruleKey: "",
      breached: daysRemaining != null && daysRemaining >= 0 && daysRemaining <= settings.tlsWarnDays,
      details,
    });
    if (settings.tlsHostnameMismatchEnabled) {
      observations.push({
        ...target,
        ruleType: "tls_hostname_mismatch",
        ruleKey: "",
        breached: endpoint.hostname_match == null ? null : !Number(endpoint.hostname_match),
        details: { ...details, hostnameMatch: endpoint.hostname_match == null ? null : Boolean(Number(endpoint.hostname_match)) },
      });
    }
  }
  const environment: MonitorAlertEnvironment = {
    id: row.id,
    name: row.name,
    sshConnectionId: "",
    connectionName: "",
    settings,
  };
  await applyObservations(app, environment, observations, now, new Set());
}

const TLS_ALERT_RULE_SQL = "('tls_expiring', 'tls_expired', 'tls_hostname_mismatch')";

export async function resetMonitorAlertEnvironment(
  app: FastifyInstance,
  environmentId: string,
  scope: "all" | "monitor" | "tls" = "all",
): Promise<void> {
  const now = new Date().toISOString();
  const ruleClause = scope === "tls"
    ? `AND rule_type IN ${TLS_ALERT_RULE_SQL}`
    : scope === "monitor"
      ? `AND rule_type NOT IN ${TLS_ALERT_RULE_SQL}`
      : "";
  await app.db.transaction(async () => {
    await app.db.prepare(`
      UPDATE monitor_alerts SET status = 'recovered', recovered_at = ?, updated_at = ?
      WHERE environment_id = ? AND status = 'active' ${ruleClause}
    `).run(now, now, environmentId);
    await app.db.prepare(`DELETE FROM monitor_alert_states WHERE environment_id = ? ${ruleClause}`).run(environmentId);
  })();
}

export async function primeMonitorAlertEnvironment(
  app: FastifyInstance,
  environmentId: string,
  options: { includeTls?: boolean } = {},
): Promise<void> {
  const environment = await app.db.prepare("SELECT workspace_type, workspace_id FROM environments WHERE id = ?").get(environmentId) as
    | { workspace_type: string; workspace_id: string }
    | undefined;
  if (!environment) return;
  const rows = await app.db.prepare(`
    SELECT h.agent_id, h.latest_host_json, h.latest_candidates_json, h.last_collected_at
    FROM monitor_hosts h
    JOIN ssh_connection_environments ce ON ce.connection_id = h.ssh_connection_id
    WHERE ce.environment_id = ? AND h.agent_id <> '' AND h.last_collected_at IS NOT NULL
    ORDER BY h.last_collected_at DESC, h.ssh_connection_id
  `).all(environmentId) as Array<{ agent_id: string; latest_host_json: string; latest_candidates_json: string; last_collected_at: string }>;
  const seenAgents = new Set<string>();
  for (const row of rows) {
    if (seenAgents.has(row.agent_id)) continue;
    seenAgents.add(row.agent_id);
    try {
      const host = JSON.parse(row.latest_host_json) as MonitorHostSnapshot;
      const candidates = JSON.parse(row.latest_candidates_json) as MonitorCandidate[];
      await evaluateMonitorAlertSamples(app, {
        agentId: row.agent_id,
        workspaceType: environment.workspace_type,
        workspaceId: environment.workspace_id,
        samples: [{ collectedAt: row.last_collected_at, host, candidates }],
      });
    } catch {
      // Invalid legacy snapshots are ignored until the next validated monitor pull.
    }
  }
  if (options.includeTls !== false) await evaluateTlsEndpointAlerts(app, environmentId);
}
