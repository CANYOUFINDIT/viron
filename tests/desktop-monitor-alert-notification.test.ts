import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { monitorAlertBody, monitorAlertRecoveryLabel, monitorAlertTargetLabel, monitorAlertTitle } from "../src/client/monitor-alert-copy.js";
import { monitorAlertNavigationQuery, type MonitorAlertItem } from "../src/shared/monitor-alerts.js";

describe("desktop monitor alert notification", () => {
  it("exposes only a typed notification command and returns clicks through a structured navigation event", () => {
    const preload = readFileSync(new URL("../src/desktop/preload.cts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/desktop/ipc/register-core-ipc.ts", import.meta.url), "utf8");
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
    expect(monitorAlertBody(alert, "active")).toBe("生产节点（node-01） 检测到新增磁盘挂载 /dev/sdc1 · /archive");
  });

  it("explains alerts ended by probe removal without reporting recovered collection", () => {
    const alert = {
      targetType: "host" as const,
      ruleType: "host_offline" as const,
      ruleKey: "",
      targetName: "node-01",
      connectionName: "生产节点",
      serviceName: "",
      details: { ignored: true, reason: "monitor_missing" },
    };
    expect(monitorAlertBody(alert, "recovered")).toBe("生产节点（node-01） 的监控探针未安装，离线告警已结束");
    expect(monitorAlertRecoveryLabel(alert)).toBe("已结束");
    expect(monitorAlertRecoveryLabel({ details: { reason: "healthy" } })).toBe("已恢复");
    expect(monitorAlertBody({ ...alert, details: { reason: "healthy" } }, "recovered")).toBe("生产节点（node-01） 的监控采集已恢复");
  });

  it("distinguishes hosts that report the same system hostname in notifications", () => {
    const alert = {
      targetType: "host" as const,
      targetName: "linux-node",
      connectionName: "应用主机 A",
      ruleType: "cpu" as const,
      ruleKey: "",
      serviceName: "",
      details: { value: 95, threshold: 90 },
    };
    expect(monitorAlertTargetLabel(alert)).toBe("应用主机 A（linux-node）");
    expect(monitorAlertTargetLabel({ ...alert, connectionName: "应用主机 B" })).toBe("应用主机 B（linux-node）");
    expect(monitorAlertBody(alert, "active")).toBe("应用主机 A（linux-node） 的 CPU 使用率达到 95.0%，阈值为 90.0%");
    expect(monitorAlertBody(alert, "recovered")).toBe("应用主机 A（linux-node） 的 CPU 使用率已恢复到阈值以内");
  });

  it.each([
    { targetType: "host" as const, connectionName: "node-01", targetName: " node-01 ", expected: "node-01" },
    { targetType: "host" as const, connectionName: "生产节点", targetName: " ", expected: "生产节点" },
    { targetType: "host" as const, connectionName: "", targetName: "node-01", expected: "node-01" },
    { targetType: "deployment" as const, connectionName: "生产节点", targetName: "订单服务节点", expected: "订单服务节点" },
    { targetType: "tls_endpoint" as const, connectionName: "生产节点", targetName: "example.com", expected: "example.com" },
  ])("formats a $targetType target without duplicate or unrelated host names", ({ expected, ...alert }) => {
    expect(monitorAlertTargetLabel(alert)).toBe(expected);
  });
});
