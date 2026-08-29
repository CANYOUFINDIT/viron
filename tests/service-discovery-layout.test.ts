import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const discoveryPanel = readFileSync(new URL("../src/client/components/ServiceDiscoveryPanel.vue", import.meta.url), "utf8");
const maintenancePanel = [
  readFileSync(new URL("../src/client/components/ServiceMaintenancePanel.vue", import.meta.url), "utf8"),
  readFileSync(new URL("../src/client/components/service-maintenance/MaintenanceServiceSelector.vue", import.meta.url), "utf8"),
  readFileSync(new URL("../src/client/components/service-maintenance/MaintenanceOperationsRibbon.vue", import.meta.url), "utf8"),
  readFileSync(new URL("../src/client/components/service-maintenance/MaintenanceDeploymentGrid.vue", import.meta.url), "utf8"),
  readFileSync(new URL("../src/client/components/service-maintenance/MaintenanceDeploymentCard.vue", import.meta.url), "utf8"),
  readFileSync(new URL("../src/client/components/service-maintenance/MaintenanceDiscoveryDrawer.vue", import.meta.url), "utf8"),
  readFileSync(new URL("../src/client/components/service-maintenance/MaintenanceBatchProgress.vue", import.meta.url), "utf8"),
].join("\n");

function styleRule(source: string, selector: string): string {
  const start = source.lastIndexOf(`${selector} {`);
  if (start < 0) return "";
  const end = source.indexOf("}", start);
  return source.slice(start, end + 1);
}

function firstStyleRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) return "";
  const end = source.indexOf("}", start);
  return source.slice(start, end + 1);
}

describe("service discovery layout", () => {
  it("keeps candidate rows in the outer workspace scroll flow", () => {
    const panelRule = styleRule(discoveryPanel, ".service-discovery");
    const listRule = styleRule(discoveryPanel, ".discovery-list");

    expect(panelRule).toContain("height: auto;");
    expect(listRule).not.toContain("overflow: auto;");
    expect(listRule).toContain("overflow: hidden;");
    expect(maintenancePanel).toContain(".host-observatory:has(> .host-observatory__pane.is-discovery)");
    expect(maintenancePanel).toContain(".maintenance-workspace:has(.host-observatory__pane.is-discovery) { overflow: auto; display: block; }");
  });

  it("removes the divider below the selected host summary", () => {
    expect(styleRule(maintenancePanel, ".host-observatory > header")).toContain("border-block-end: 0;");
  });

  it("keeps both host workspace tab bars compact without shrinking coarse-pointer targets", () => {
    const workspaceTabs = firstStyleRule(maintenancePanel, ".host-workspace-tabs");
    const workspaceButtons = firstStyleRule(maintenancePanel, ".host-workspace-tabs button");
    const providerTabs = firstStyleRule(discoveryPanel, ".discovery-provider-tabs");
    const providerButtons = firstStyleRule(discoveryPanel, ".discovery-provider-tabs button");

    expect(workspaceTabs).toContain("padding: 3px;");
    expect(workspaceButtons).toContain("min-height: 2.125rem;");
    expect(providerTabs).toContain("padding: 3px;");
    expect(providerButtons).toContain("min-height: 2.125rem;");
    expect(maintenancePanel).toContain(".host-workspace-tabs button { min-width: 2.75rem; min-height: 2.75rem; }");
    expect(discoveryPanel).toContain(".discovery-provider-tabs button { min-height: 2.75rem; }");
  });

  it("keeps host monitoring charts beside service discovery", () => {
    expect(maintenancePanel).toContain("HostMonitorDashboard");
    expect(maintenancePanel).toContain("host-metric-grid");
    expect(maintenancePanel).toContain("v-model:focus-metric");
    expect(maintenancePanel).toContain("$t('监控')");
    expect(maintenancePanel).toContain("$t('服务发现')");
    expect(maintenancePanel).toContain("hostWorkspaceTab === 'monitor'");
    expect(maintenancePanel).toContain("hostWorkspaceTab === 'discovery'");
  });

  it("removes certificates from the service maintenance page", () => {
    expect(maintenancePanel).toContain("maintenance-switcher__primary");
    expect(maintenancePanel).toContain("$t('服务')");
    expect(maintenancePanel).not.toContain("maintenance-switcher__certificate");
    expect(maintenancePanel).not.toContain("$t('证书告警')");
    expect(maintenancePanel).not.toContain("$t('登记证书')");
    expect(maintenancePanel).not.toContain("DeploymentMonitorDashboard");
    expect(maintenancePanel).toContain("$t('清理监控数据')");
    expect(maintenancePanel).toContain("$t('扫描并拉取')");
    expect(maintenancePanel).toContain("$t('扫描发现')");
    expect(maintenancePanel).toContain("$t('配置按钮')");
    expect(maintenancePanel).toContain("$t('刷新')");
    expect(maintenancePanel).toContain("$t('直连 SSH')");
    expect(maintenancePanel).toContain("$t('节点日志')");
    expect(maintenancePanel).toContain('emit(\'open-ssh\'');
  });
});
