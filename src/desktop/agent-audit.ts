import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSettingsScope } from "./agent-settings.js";

export interface AgentAuditRecord {
  id: string;
  scope: string;
  action: string;
  target: string;
  summary: string;
  createdAt: string;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function scopeKey(scope: AgentSettingsScope) {
  return createHash("sha256").update(`${scope.vironEndpoint}\0${scope.vironUserId}`).digest("hex");
}

export class DesktopAgentAuditStore {
  constructor(private readonly userDataPath: string) {}
  private path() { return join(this.userDataPath, "ai-agent-audit.json"); }
  private read(): AgentAuditRecord[] {
    try { return JSON.parse(readFileSync(this.path(), "utf8")) as AgentAuditRecord[]; } catch { return []; }
  }
  private write(records: AgentAuditRecord[]) {
    mkdirSync(this.userDataPath, { recursive: true });
    writeFileSync(this.path(), `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  append(scope: AgentSettingsScope, action: string, target: string, summary: string): void {
    const cutoff = Date.now() - RETENTION_MS;
    const records = this.read().filter((item) => Date.parse(item.createdAt) >= cutoff);
    records.push({ id: randomUUID(), scope: scopeKey(scope), action, target: target.slice(0, 500), summary: summary.slice(0, 1_000), createdAt: new Date().toISOString() });
    this.write(records.slice(-2_000));
  }
  clear(scope: AgentSettingsScope): { cleared: number } {
    const key = scopeKey(scope); const records = this.read(); const next = records.filter((item) => item.scope !== key);
    this.write(next); return { cleared: records.length - next.length };
  }
}
