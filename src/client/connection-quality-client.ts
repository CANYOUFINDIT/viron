import { api } from "./api";
import { desktopRequest, isDesktopApp, probeDesktopConnectionQualityTarget } from "./desktop";
import { connectionQualityByteLength, recordConnectionQualityTraffic } from "./connection-quality-traffic";
import type { ConnectionQualitySpeedTestResult } from "../shared/connection-quality";

const SPEED_TEST_BYTES = 256 * 1024;

export async function probeVironService(): Promise<number> {
  const started = performance.now();
  await api<{ serverAt: number }>(`/api/v1/connection-quality/ping?t=${Date.now()}`);
  return Math.max(0, Math.round(performance.now() - started));
}

export async function probeConnectionTarget(id: string, executionMode: "server" | "local"): Promise<number> {
  if (executionMode === "local") {
    if (!isDesktopApp()) throw new Error("本机目标只能由所属桌面 App 探测");
    return probeDesktopConnectionQualityTarget(id);
  }
  const response = await api<{ latencyMs: number }>(`/api/v1/connection-quality/targets/${encodeURIComponent(id)}/probe?t=${Date.now()}`);
  return response.latencyMs;
}

async function rawRequest(path: string, init: RequestInit = {}): Promise<string> {
  const bodyBytes = connectionQualityByteLength(init.body);
  if (bodyBytes) recordConnectionQualityTraffic("upload", bodyBytes);
  if (isDesktopApp()) {
    const response = await desktopRequest(path, init);
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    recordConnectionQualityTraffic("download", connectionQualityByteLength(response.body));
    return response.body;
  }
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  recordConnectionQualityTraffic("download", connectionQualityByteLength(text));
  return text;
}

export async function runVironSpeedTest(): Promise<ConnectionQualitySpeedTestResult> {
  const payload = "0".repeat(SPEED_TEST_BYTES);
  const uploadBody = JSON.stringify({ payload });
  const uploadStarted = performance.now();
  await rawRequest("/api/v1/connection-quality/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: uploadBody,
  });
  const uploadSeconds = Math.max(0.001, (performance.now() - uploadStarted) / 1000);

  const downloadStarted = performance.now();
  const downloaded = await rawRequest(`/api/v1/connection-quality/download?bytes=${SPEED_TEST_BYTES}`);
  const downloadSeconds = Math.max(0.001, (performance.now() - downloadStarted) / 1000);
  return {
    uploadBytesPerSecond: Math.round(connectionQualityByteLength(uploadBody) / uploadSeconds),
    downloadBytesPerSecond: Math.round(connectionQualityByteLength(downloaded) / downloadSeconds),
    testedAt: new Date().toISOString(),
  };
}
