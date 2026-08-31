import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const monitoringView = readFileSync(new URL("../src/client/views/MonitoringView.vue", import.meta.url), "utf8");
const noc = readFileSync(new URL("../src/client/components/monitoring/NocScreen.vue", import.meta.url), "utf8");
const alertService = readFileSync(new URL("../src/client/components/monitoring/AlertServicePanel.vue", import.meta.url), "utf8");
const environment = readFileSync(new URL("../src/client/views/EnvironmentDetailView.vue", import.meta.url), "utf8");
const router = readFileSync(new URL("../src/client/router.ts", import.meta.url), "utf8");
const alerts = readFileSync(new URL("../src/client/components/MonitorAlertCenter.vue", import.meta.url), "utf8");
const hostDashboard = readFileSync(new URL("../src/client/components/HostMonitorDashboard.vue", import.meta.url), "utf8");
const hostFleet = readFileSync(new URL("../src/client/components/monitoring/HostFleetPanel.vue", import.meta.url), "utf8");
const hostEventCalendar = readFileSync(new URL("../src/client/components/monitoring/HostEventCalendar.vue", import.meta.url), "utf8");
const maintenanceDiscovery = readFileSync(new URL("../src/client/components/service-maintenance/MaintenanceDiscoveryDrawer.vue", import.meta.url), "utf8");

describe("monitoring dashboard wiring", () => {
  it("registers the global monitoring route and cancels overlapping overview requests", () => {
    expect(router).toContain('path: "/monitoring"');
    expect(monitoringView).toContain("overviewAbort?.abort()");
    expect(noc).toContain("host.stale");
    expect(noc).toContain("is-unknown");
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

  it("shows a GitHub-style host event heatmap in monitoring and service maintenance", () => {
    expect(alertService).toContain("mode=\"platform\"");
    expect(alertService).toContain("HostEventCalendar");
    expect(alertService).toContain("/api/v1/monitoring/events?");
    expect(alertService).toContain("系统历史数据，不受个人通知读取或清除影响");
    expect(alertService).toContain('pageSize: 5');
    expect(alertService).toContain('order: "priority"');
    expect(alertService).toContain("查看全部系统告警");
    expect(alertService).not.toContain("/api/v1/monitor-alerts");
    expect(hostEventCalendar).toContain("系统历史告警统计，不受个人通知读取或清除影响");
    expect(hostFleet).toContain("priority-host-grid");
    expect(hostFleet).toContain("优先处理原因");
    expect(hostFleet).toContain("离线与严重告警优先，其次按资源压力排序");
    expect(hostFleet).not.toContain("host-pressure-score");
    expect(maintenanceDiscovery).toContain("<HostEventCalendar");
    expect(maintenanceDiscovery).toContain(':host-id="selectedHost.sshConnectionId"');
    expect(hostEventCalendar).toContain("/event-calendar?");
    expect(hostEventCalendar).toContain("/events?");
    expect(hostEventCalendar).toContain("rangeMonths");
    expect(hostEventCalendar).toContain("heatmapWeeks");
    expect(hostEventCalendar).toContain("event-calendar__week");
    expect(hostEventCalendar).toContain("day.coverageRatio < 0.8");
    expect(hostEventCalendar).toContain("event.occurrenceCount > 1");
    expect(hostEventCalendar).toContain("monitorEventCalendarCacheKey");
    expect(hostEventCalendar).toContain("cachedCalendars ?? []");
    expect(hostDashboard).toContain("monitorHistoryCacheKey");
    expect(hostDashboard).toContain("cachedHistory ?? emptyHistory()");
  });

  it("keeps the dashboard to two pages and shows empty-state copy for monitoring panels", () => {
    expect(monitoringView).not.toContain("loadAlerts");
    expect(monitoringView).not.toContain("NOC 全屏");
    expect(monitoringView).toContain("$t('告警与服务')");
    expect(monitoringView).toContain("$t('主机节点')");
    expect(alertService).toContain("$t('重点告警事件')");
    expect(alertService).toContain("$t('服务')");
    expect(hostFleet).toContain("$t('返回主机节点')");
    expect(noc).toContain("<Teleport to=\"body\">");
    expect(noc).toContain("$t('暂无活动告警')");
    expect(noc).toContain("$t('暂无主机矩阵')");
    expect(noc).toContain("$t('网络吞吐排行')");
    expect(noc).toContain("$t('存储容量水位')");
    expect(noc).toContain("noc-donut");
    expect(noc).toContain("noc-wave");
    expect(hostDashboard).toContain("$t('前往服务维护')");
    expect(environment).toContain("workspaceQuery.maintenanceServiceId || workspaceQuery.serviceId");
    expect(environment).toContain("workspaceQuery.maintenanceHostId || workspaceQuery.hostId");
    expect(environment).toContain("@open-ssh=\"openServiceSsh\"");
    expect(environment).toContain("tab: \"ssh\", connectionId");
    expect(monitoringView).toContain('query: { tab: "maintenance", serviceId: service.id }');
    expect(monitoringView).toContain("$t('全部环境')");
    expect(monitoringView).not.toContain("environmentId: environmentId.value || firstMonitored.environmentId");
    expect(monitoringView).not.toContain("environmentId: environmentId.value || host.environmentId");
    expect(monitoringView).toContain("patchQuery({ view: \"hosts\", hostId: host?.sshConnectionId })");
    expect(monitoringView).toContain("hostId: undefined");
    expect(monitoringView).toContain("MONITORING_HOST_PAGE_SIZE");
    expect(monitoringView).toContain("hostOffset");
    expect(monitoringView).toContain("hostsOnly");
    expect(monitoringView).toContain("mergeHostPage");
    expect(monitoringView).toContain("function isMonitoringRoute()");
    expect(monitoringView).toContain("if (!isMonitoringRoute()) return;");
  });
});
