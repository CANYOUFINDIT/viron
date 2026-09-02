/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));

import { api } from "../src/client/api";
import AlertServicePanel from "../src/client/components/monitoring/AlertServicePanel.vue";
import { i18nPlugin, language } from "../src/client/i18n";
import type { MonitorPlatformEventItem } from "../src/shared/monitor-alerts";

const mockedApi = vi.mocked(api);

const diskMissingEvent: MonitorPlatformEventItem = {
  id: "event-1",
  ruleType: "disk_missing",
  ruleKey: "disk:/data",
  status: "recovered",
  severity: "critical",
  peakSeverity: "critical",
  occurrenceCount: 1,
  targetName: "192.168.5.146",
  details: { device: "sda1", path: "/data" },
  triggeredAt: "2026-08-31T12:00:00.000Z",
  recoveredAt: "2026-08-31T13:00:00.000Z",
  lastSeenAt: "2026-08-31T13:00:00.000Z",
  environmentId: "env-1",
  environmentName: "开发环境",
  sshConnectionId: "host-1",
  serviceId: null,
  serviceName: "",
  connectionName: "192.168.5.146",
  targetType: "host",
};

beforeEach(() => {
  language.value = "zh-CN";
  mockedApi.mockReset();
  mockedApi.mockResolvedValue({
    items: [diskMissingEvent],
    total: 1,
    page: 1,
    pageSize: 5,
  });
});

describe("alert service panel", () => {
  it("renders the complete alert body below the rule title", async () => {
    const wrapper = mount(AlertServicePanel, {
      props: {
        environmentId: "env-1",
        environments: [{ id: "env-1", name: "开发环境" }],
        services: [],
      },
      global: {
        plugins: [i18nPlugin],
        directives: { loading: { mounted() {} } },
        stubs: {
          HostEventCalendar: true,
          "el-input": true,
          "el-drawer": { template: "<div><slot /></div>" },
          "el-select": true,
          "el-option": true,
          "el-pagination": true,
        },
      },
    });

    await flushPromises();

    const row = wrapper.get(".priority-event-panel button.event-row");
    expect(row.get("strong").text()).toBe("掉盘");
    expect(row.get(".event-message").text()).toBe("192.168.5.146 的磁盘 sda1 · /data 已重新出现");
  });
});
