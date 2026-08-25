import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { monitorAlertBody, monitorAlertTitle } from "../src/client/monitor-alert-copy.js";
import { monitorAlertNavigationQuery, type MonitorAlertItem } from "../src/shared/monitor-alerts.js";

describe("desktop monitor alert notification", () => {
  it("exposes only a typed notification command and returns clicks through a structured navigation event", () => {
    const preload = readFileSync(new URL("../src/desktop/preload.cts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
    const center = readFileSync(new URL("../src/client/components/MonitorAlertCenter.vue", import.meta.url), "utf8");
    expect(preload).toContain('ipcRenderer.invoke("viron:monitor-alert:notify", input)');
    expect(preload).toContain('ipcRenderer.on("viron:monitor-alert-open", handler)');
    expect(main).toContain('ipcMain.handle("viron:monitor-alert:notify"');
    expect(main).toContain("monitorAlertNotificationInput(value)");
    expect(main).toContain('mainWindow?.webContents.send("viron:monitor-alert-open", input)');
    expect(main).not.toContain('shell.openExternal(input.url)');
    expect(center).toContain("await switchWorkspace(workspace)");
    expect(center).toContain("window.location.assign(href)");
    expect(center).toContain("workspaceName: alert.workspaceName");
  });

  it("builds a service-maintenance route without accepting an arbitrary URL", () => {
    expect(monitorAlertNavigationQuery({ sshConnectionId: "host-id", serviceId: "service-id", deploymentId: "deployment-id" })).toEqual({
      tab: "maintenance",
      maintenanceServiceId: "service-id",
      maintenanceDeploymentId: "deployment-id",
    });
    expect(monitorAlertNavigationQuery({ sshConnectionId: "host-id", serviceId: null, deploymentId: null })).toEqual({
      tab: "maintenance",
      maintenanceHostId: "host-id",
    });
  });

  it("renders disk additions as system-notifiable one-time events", () => {
    const alert: MonitorAlertItem = {
      id: "alert-id",
      workspaceType: "organization",
      workspaceId: "workspace-id",
      workspaceName: "核心业务组",
      environmentId: "environment-id",
      environmentName: "生产环境",
      targetType: "host",
      targetId: "agent-id",
      ruleType: "disk_added",
      ruleKey: JSON.stringify(["/dev/sdc1", "/archive"]),
      sshConnectionId: "host-id",
      serviceId: null,
      deploymentId: null,
      targetName: "node-01",
      connectionName: "生产节点",
      serviceName: "",
      status: "event",
      details: { device: "/dev/sdc1", path: "/archive", added: true },
      triggeredAt: "2026-08-10T10:00:00.000Z",
      recoveredAt: null,
      notificationPhase: "active",
      read: false,
    };
    expect(monitorAlertTitle(alert, "active")).toBe("监控事件 · 核心业务组 / 生产环境");
    expect(monitorAlertBody(alert, "active")).toBe("node-01 检测到新增磁盘挂载 /dev/sdc1 · /archive");
  });
});
