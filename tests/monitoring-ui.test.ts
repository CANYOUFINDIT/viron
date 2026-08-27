import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const monitoringView = readFileSync(new URL("../src/client/views/MonitoringView.vue", import.meta.url), "utf8");
const noc = readFileSync(new URL("../src/client/components/monitoring/NocScreen.vue", import.meta.url), "utf8");
const router = readFileSync(new URL("../src/client/router.ts", import.meta.url), "utf8");
const alerts = readFileSync(new URL("../src/client/components/MonitorAlertCenter.vue", import.meta.url), "utf8");

describe("monitoring dashboard wiring", () => {
  it("registers the global monitoring route and cancels overlapping overview requests", () => {
    expect(router).toContain('path: "/monitoring"');
    expect(monitoringView).toContain("overviewAbort?.abort()");
    expect(monitoringView).toContain("timeseriesAbort?.abort()");
    expect(monitoringView).toContain("document.hidden");
    expect(monitoringView).not.toContain("EnvironmentMonitoringDashboard");
    expect(monitoringView).not.toContain("DeploymentMonitorDashboard");
  });

  it("uses Fullscreen API and reduced motion for NOC", () => {
    expect(noc).toContain("requestFullscreen");
    expect(noc).toContain("fullscreenchange");
    expect(noc).toContain("prefers-reduced-motion");
    expect(noc).toContain("keydown");
  });

  it("sends host and service alerts to the monitoring dashboard", () => {
    expect(alerts).toContain('name: "monitoring"');
    expect(alerts).toContain('name: "ssh-keys"');
  });
});
