import type { ActiveConnectionType } from "./active-connection.js";

export type ConnectionQualityStatus = "idle" | "good" | "fair" | "poor" | "offline";

export interface ConnectionQualityProbeSample {
  at: number;
  latencyMs: number | null;
}

export interface ConnectionQualityHealth {
  latencyMs: number | null;
  jitterMs: number | null;
  failureRate: number;
  status: ConnectionQualityStatus;
}

export interface ConnectionQualityLink extends ConnectionQualityHealth {
  id: string;
  label: string;
  detail: string;
  uploadBytesPerSecond: number;
  downloadBytesPerSecond: number;
}

export interface ConnectionQualityTargetLink extends ConnectionQualityLink {
  type: ActiveConnectionType;
  executionMode: "server" | "local";
  lastActivityAt: string;
}

export interface ConnectionQualitySpeedTestResult {
  uploadBytesPerSecond: number;
  downloadBytesPerSecond: number;
  testedAt: string;
}

export interface ConnectionQualityTargetAddress {
  host: string;
  port: number;
}

export interface ConnectionQualityOverlayState {
  bounds: { x: number; y: number; width: number; height: number };
  rootOffset: { x: number; y: number };
  panelSize: { width: number; height: number };
  expanded: boolean;
  dragging: boolean;
  testing: boolean;
  service: ConnectionQualityLink;
  target: ConnectionQualityTargetLink | null;
  targets: ConnectionQualityTargetLink[];
  speedTest: ConnectionQualitySpeedTestResult | null;
  interactionLayer?: boolean;
}

export type ConnectionQualityOverlayAction =
  | { type: "toggle-details" | "run-test" }
  | { type: "select-target"; targetId: string }
  | { type: "drag-start" | "drag-move" | "drag-end"; screenX: number; screenY: number };

export const CONNECTION_QUALITY_PANEL_WIDTH = 326;
export const CONNECTION_QUALITY_PANEL_COLLAPSED_HEIGHT = 104;
export const CONNECTION_QUALITY_PANEL_EXPANDED_HEIGHT = 376;

export function connectionQualityHealth(samples: readonly ConnectionQualityProbeSample[]): ConnectionQualityHealth {
  if (!samples.length) return { latencyMs: null, jitterMs: null, failureRate: 0, status: "idle" };
  const successes = samples.flatMap((sample) => sample.latencyMs === null ? [] : [sample.latencyMs]);
  const failureRate = (samples.length - successes.length) / samples.length;
  if (!successes.length) return { latencyMs: null, jitterMs: null, failureRate, status: "offline" };
  const latencyMs = Math.round(successes.reduce((sum, value) => sum + value, 0) / successes.length);
  const deltas = successes.slice(1).map((value, index) => Math.abs(value - successes[index]!));
  const jitterMs = deltas.length ? Math.round(deltas.reduce((sum, value) => sum + value, 0) / deltas.length) : 0;
  const status: ConnectionQualityStatus = failureRate >= 0.2 || latencyMs >= 250 || jitterMs >= 80
    ? "poor"
    : failureRate > 0.05 || latencyMs >= 100 || jitterMs >= 30 ? "fair" : "good";
  return { latencyMs, jitterMs, failureRate, status };
}

export function appendConnectionQualitySample(
  samples: readonly ConnectionQualityProbeSample[],
  sample: ConnectionQualityProbeSample,
  limit = 20,
): ConnectionQualityProbeSample[] {
  return [...samples, sample].slice(-limit);
}

export function connectionQualityOverlayInteractionState(state: ConnectionQualityOverlayState): ConnectionQualityOverlayState {
  return {
    ...state,
    interactionLayer: true,
    bounds: {
      x: state.bounds.x + state.rootOffset.x,
      y: state.bounds.y + state.rootOffset.y,
      width: state.panelSize.width,
      height: state.panelSize.height,
    },
    rootOffset: { x: 0, y: 0 },
  };
}
