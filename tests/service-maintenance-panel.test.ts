/** @vitest-environment happy-dom */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

import { api } from "../src/client/api";
import { i18nPlugin } from "../src/client/i18n";
import ServiceMaintenancePanel from "../src/client/components/ServiceMaintenancePanel.vue";

const mockedApi = vi.mocked(api);

afterEach(() => {
  vi.clearAllMocks();
});

function stubControl() {
  return {
    props: ["modelValue", "disabled", "loading", "type", "plain"],
    emits: ["click", "update:modelValue"],
    template: `<button :disabled="Boolean(disabled || loading)" @click="$emit('click')"><slot /></button>`,
  };
}

describe("service maintenance panel split", () => {
  it("does not keep TLS types or the unused certificate composable in the maintenance module", () => {
    expect(existsSync(new URL("../src/client/components/service-maintenance/use-tls-certificates.ts", import.meta.url))).toBe(false);
    const files = [
      "ServiceMaintenancePanel.vue",
      "service-maintenance/context.ts",
      "service-maintenance/types.ts",
      "service-maintenance/api-contract.ts",
      "service-maintenance/use-maintenance-payload.ts",
      "service-maintenance/use-maintenance-actions.ts",
      "service-maintenance/use-alert-settings.ts",
      "service-maintenance/MaintenanceServiceSelector.vue",
      "service-maintenance/MaintenanceOperationsRibbon.vue",
      "service-maintenance/MaintenanceDeploymentGrid.vue",
      "service-maintenance/MaintenanceDeploymentCard.vue",
      "service-maintenance/MaintenanceDiscoveryDrawer.vue",
      "service-maintenance/MaintenanceBatchProgress.vue",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), "src/client/components", file), "utf8");
      expect(source).not.toContain("use-tls-certificates");
      expect(source).not.toContain("shared/tls-certificates");
    }
    const alertSettings = readFileSync(join(process.cwd(), "src/client/components/service-maintenance/use-alert-settings.ts"), "utf8");
    expect(alertSettings).not.toContain('"tls"');
    expect(alertSettings).not.toContain("tlsEnabled");
    const grid = readFileSync(join(process.cwd(), "src/client/components/service-maintenance/MaintenanceDeploymentGrid.vue"), "utf8");
    expect(grid).toContain("MaintenanceDeploymentCard");
    const panel = readFileSync(join(process.cwd(), "src/client/components/ServiceMaintenancePanel.vue"), "utf8");
    expect(panel).toContain("MaintenanceServiceSelector");
    expect(panel).toContain("MaintenanceOperationsRibbon");
    expect(panel).toContain("MaintenanceDeploymentGrid");
    expect(panel).toContain("MaintenanceDiscoveryDrawer");
    expect(panel).toContain("MaintenanceBatchProgress");
  });

  it("selects a service and exposes batch progress after choosing deployments", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (String(path).includes("/service-deployments") && !String(path).includes("/actions")) {
        return {
          canConfigure: true,
          canOperate: true,
          scriptActionsSupported: true,
          generatedAt: new Date().toISOString(),
          truncated: false,
          services: [{
            id: "svc-1",
            name: "订单 API",
            description: "",
            status: "active",
            scriptActions: [],
            logIds: ["log-1"],
            deployments: [
              { id: "dep-1", provider: "systemd", displayName: "api-a", externalId: "api.service", sshConnectionId: "ssh-1", sshConnectionName: "host-a", status: "running", state: "active", metrics: {}, connectionAvailable: true, capabilities: ["start", "stop", "restart"], capabilityNotes: {}, scriptActions: [], lastCheckedAt: null },
              { id: "dep-2", provider: "systemd", displayName: "api-b", externalId: "worker.service", sshConnectionId: "ssh-1", sshConnectionName: "host-a", status: "running", state: "active", metrics: {}, connectionAvailable: true, capabilities: ["start", "stop", "restart"], capabilityNotes: {}, scriptActions: [], lastCheckedAt: null },
            ],
          }],
          logs: [{ id: "log-1", name: "应用日志", sshConnectionId: "ssh-1", connectionName: "host-a", filePaths: ["/var/log/app.log"] }],
          discovery: { hosts: [{ sshConnectionId: "ssh-1", connectionName: "host-a", host: "127.0.0.1", connectionAvailable: true, monitorStatus: "ready", candidateCount: 0 }] },
        };
      }
      return { item: { enabled: false } };
    });

    const wrapper = mount(ServiceMaintenancePanel, {
      props: { environmentId: "env-1" },
      global: {
        plugins: [i18nPlugin],
        stubs: {
          "el-button": stubControl(),
          "el-dialog": { template: "<div class='el-dialog-stub'></div>", props: ["modelValue"] },
          "el-dropdown": { template: "<div><slot /><slot name='dropdown' /></div>" },
          "el-dropdown-menu": { template: "<div><slot /></div>" },
          "el-dropdown-item": { template: "<button><slot /></button>" },
          "el-form": { template: "<form><slot /></form>" },
          "el-form-item": { template: "<div><slot /></div>" },
          "el-input": true,
          "el-select": true,
          "el-option": true,
          "el-switch": true,
          "el-checkbox": true,
          "el-checkbox-group": true,
          "el-radio-group": true,
          "el-radio-button": true,
          "el-progress": true,
          AnimatedCounter: true,
        },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("订单 API");
    expect(wrapper.find(".deployment-card__ops").exists()).toBe(true);
    const selectAll = wrapper.find(".deployment-select-all input");
    expect(selectAll.exists()).toBe(true);
    await selectAll.setValue(true);
    await flushPromises();
    expect(wrapper.text()).toMatch(/批量重启|Batch restart/);
    wrapper.unmount();
  });

  it("loads the selected host snapshot and shows monitoring next to discovery", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (String(path).includes("/service-deployments") && !String(path).includes("/actions")) {
        return {
          canConfigure: true,
          canOperate: true,
          scriptActionsSupported: false,
          generatedAt: new Date().toISOString(),
          truncated: false,
          services: [],
          logs: [],
          discovery: { hosts: [{ sshConnectionId: "ssh-1", connectionName: "192.168.5.195", host: "192.168.5.195", connectionAvailable: true, monitorStatus: "ready", candidateCount: 2 }] },
        };
      }
      if (String(path).includes("/candidates")) {
        return {
          item: {
            sshConnectionId: "ssh-1",
            connectionName: "192.168.5.195",
            host: "192.168.5.195",
            port: 22,
            username: "root",
            monitorStatus: "ready",
            lastCollectedAt: new Date().toISOString(),
            snapshot: {
              hostname: "node-a",
              cpuCount: 8,
              cpuUsedPercent: 12.5,
              load1: 0.42,
              load5: 0.31,
              load15: 0.2,
              memoryTotalBytes: 16 * 1024 * 1024 * 1024,
              memoryUsedBytes: 4 * 1024 * 1024 * 1024,
              memoryUsedPercent: 25,
              uptimeSeconds: 3600,
              disks: [{ path: "/", totalBytes: 100, freeBytes: 40, usedBytes: 60, usedPercent: 60 }],
              temperatures: [],
            },
            candidates: [{ provider: "systemd", externalId: "api.service", name: "api", status: "running", state: "active" }],
            kubernetesConfigs: [],
          },
        };
      }
      return { item: { enabled: false } };
    });

    const wrapper = mount(ServiceMaintenancePanel, {
      props: { environmentId: "env-1", focusHostId: "ssh-1" },
      global: {
        plugins: [i18nPlugin],
        stubs: {
          "el-button": stubControl(),
          "el-dialog": { template: "<div class='el-dialog-stub'></div>", props: ["modelValue"] },
          "el-dropdown": { template: "<div><slot /><slot name='dropdown' /></div>" },
          "el-dropdown-menu": { template: "<div><slot /></div>" },
          "el-dropdown-item": { template: "<button><slot /></button>" },
          "el-form": { template: "<form><slot /></form>" },
          "el-form-item": { template: "<div><slot /></div>" },
          "el-input": true,
          "el-select": true,
          "el-option": true,
          "el-switch": true,
          "el-checkbox": true,
          "el-checkbox-group": true,
          "el-radio-group": true,
          "el-radio-button": true,
          "el-progress": true,
          AnimatedCounter: true,
          HostMonitorDashboard: { template: `<div class="host-monitor-stub">host-charts</div>` },
          ServiceDiscoveryPanel: { template: `<div class="discovery-stub">discovery-list</div>` },
        },
      },
    });
    await flushPromises();
    expect(wrapper.text()).toMatch(/监控|Monitoring/);
    expect(wrapper.text()).toMatch(/服务发现|Service discovery/);
    expect(wrapper.find(".host-metric-grid").exists()).toBe(true);
    expect(wrapper.find(".host-monitor-stub").exists()).toBe(true);
    expect(wrapper.text()).toContain("12.5%");
    const discoveryTab = wrapper.findAll("[role='tab']").find((button) => /服务发现|Service discovery/.test(button.text()));
    expect(discoveryTab).toBeTruthy();
    await discoveryTab!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".discovery-stub").exists()).toBe(true);
    wrapper.unmount();
  });
});
