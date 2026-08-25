import { createHash, randomUUID } from "node:crypto";
import type { Session } from "electron";
import type { DesktopExecutionMode } from "../shared/execution-mode.js";
import type { ProductCapabilities } from "./endpoint.js";
import { readState, writeState } from "./app-state.js";

export interface ActiveEndpoint {
  endpoint: string;
  protocolVersion: number;
  capabilities: ProductCapabilities;
  partition: Session;
}

export let activeEndpoint: ActiveEndpoint | null = null;

export function setActiveEndpoint(next: ActiveEndpoint | null): void {
  activeEndpoint = next;
}

export function endpointStateKey(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export function executionModeForEndpoint(endpoint: string): DesktopExecutionMode {
  return readState().executionModes?.[endpointStateKey(endpoint)] === "server" ? "server" : "local";
}

export function currentExecutionMode(): DesktopExecutionMode {
  return activeEndpoint ? executionModeForEndpoint(activeEndpoint.endpoint) : "local";
}

export function executionScopeForEndpoint(endpoint: string): string {
  const state = readState();
  const key = endpointStateKey(endpoint);
  const existing = state.executionScopes?.[key];
  if (existing) return existing;
  const created = randomUUID();
  writeState({ ...state, executionScopes: { ...state.executionScopes, [key]: created } });
  return created;
}
