/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { ElMessage } from "element-plus";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";



vi.mock("../src/client/api", () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }
  return { api: vi.fn(), ApiError };
});

import { ApiError, api } from "../src/client/api";
import { i18nPlugin, language } from "../src/client/i18n";
import CertificateCenter from "../src/client/components/credentials/CertificateCenter.vue";
import type { SslCertificateAsset } from "../src/shared/tls-certificates.js";

const mockedApi = vi.mocked(api);

function sampleAsset(id: string, name: string): SslCertificateAsset {
  const now = "2026-08-27T00:00:00.000Z";
  return {
    id,
    fingerprintSha256: `${id.replace(/-/g, "").slice(0, 32)}${"ab".repeat(16)}`.slice(0, 64),
    leafCn: name,
    leafSans: [name],
    issuer: "Issuer",
    serial: "1",
    signatureAlgorithm: "sha256",
    notBefore: now,
    notAfter: "2026-09-26T00:00:00.000Z",
    isSelfSigned: false,
    status: "valid",
    daysRemaining: 30,
    orphan: false,
    endpointCount: 1,
    webEntryCount: 1,
    endpoints: [],
    webEntries: [{ id: `${id}-web`, name, url: `https://${name}`, environmentId: "env", environmentName: "Env" }],
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

const assets = [sampleAsset("11111111-1111-4111-8111-111111111111", "a.example.com"), sampleAsset("22222222-2222-4222-8222-222222222222", "b.example.com")];

function stubButton() {
  return {
    props: ["loading", "disabled", "type", "text"],
    emits: ["click"],
    template: `<button :disabled="Boolean(disabled || loading)" @click="$emit('click')"><slot /></button>`,
  };
}

async function mountCenter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
  });
  await router.push("/ssh-keys?tab=ssl");
  const wrapper = mount(CertificateCenter, {
    global: {
      plugins: [router, i18nPlugin],
      stubs: {
        "el-button": stubButton(),
        "el-input": true,
        "el-select": true,
        "el-option": true,
        "el-dialog": true,
        "el-form": true,
        "el-form-item": true,
        "el-input-number": true,
        RefreshCw: true,
        Search: true,
        ShieldCheck: true,
        Trash2: true,
      },
      directives: { loading: () => undefined },
    },
  });
  await flushPromises();
  return wrapper;
}

function mockListAndLookups(probeImpl?: (path: string) => Promise<unknown>) {
  mockedApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/environments")) return { items: [] };
    if (path.startsWith("/api/v1/connections")) return { items: [] };
    if (path.startsWith("/api/v1/certificates?") || path.startsWith("/api/v1/certificates&")) {
      return { items: assets, summary: { total: 2, valid: 2, expiring: 0, expired: 0, error: 0, orphan: 0 } };
    }
    if (path.includes("/probe")) {
      if (probeImpl) return await probeImpl(path);
      return { probed: 1 };
    }
    return {};
  });
}

describe("certificate center UI", () => {
  beforeEach(() => {
    language.value = "zh-CN";
    mockedApi.mockReset();
    vi.spyOn(ElMessage, "success").mockImplementation(() => ({}) as never);
    vi.spyOn(ElMessage, "error").mockImplementation(() => ({}) as never);
    vi.spyOn(ElMessage, "warning").mockImplementation(() => ({}) as never);
  });

  it("keeps the credentials entry and does not import the untracked monitoring dashboard", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
    expect(source("src/client/components/AppShell.vue")).toContain('label: tr("密钥与证书")');
    expect(source("src/client/views/SshKeysView.vue")).toContain("CertificateCenter");
    expect(source("src/client/views/SshKeysView.vue")).not.toContain("EnvironmentMonitoringDashboard");
    expect(source("src/client/views/EnvironmentDetailView.vue")).not.toContain("EnvironmentMonitoringDashboard");
    expect(source("src/client/views/EnvironmentDetailView.vue")).toContain("TlsPopover");
  });

  it("shows queue progress and a success summary when every target is probed", async () => {
    mockListAndLookups();
    const wrapper = await mountCenter();
    await (wrapper.vm as unknown as { probeAll: () => Promise<void> }).probeAll();
    await flushPromises();
    expect(wrapper.get("[data-testid='certificate-batch-summary']").text()).toContain("2 / 2");
    expect(wrapper.get("[data-testid='certificate-batch-summary']").text()).toContain("成功 2");
    expect(ElMessage.success).toHaveBeenCalled();
    expect(wrapper.find("[data-testid='certificate-batch-failures']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps partial success, all-failure, 429 and duplicate clicks visible", async () => {
    let probeCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mockListAndLookups(async (path) => {
      probeCalls += 1;
      if (probeCalls === 1) await firstGate;
      if (path.includes(assets[0]!.id)) return { probed: 1 };
      throw new ApiError("同一端点 1 分钟内只能重新探测一次", 429, "TLS_PROBE_RATE_LIMIT");
    });
    const wrapper = await mountCenter();
    const vm = wrapper.vm as unknown as { probeAll: () => Promise<void>; retryFailed: () => Promise<void> };
    const first = vm.probeAll();
    await flushPromises();
    const duplicate = vm.probeAll();
    await duplicate;
    expect(probeCalls).toBe(1);
    releaseFirst();
    await first;
    await flushPromises();
    expect(wrapper.get("[data-testid='certificate-batch-failures']").text()).toContain("b.example.com");
    expect(wrapper.get("[data-testid='certificate-batch-summary']").text()).toContain("成功 1");
    expect(ElMessage.warning).toHaveBeenCalled();

    let clock = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/environments")) return { items: [] };
      if (path.startsWith("/api/v1/connections")) return { items: [] };
      if (path.includes("/probe")) throw new ApiError("database down", 500, "INTERNAL");
      if (path.startsWith("/api/v1/certificates")) {
        return { items: assets, summary: { total: 2, valid: 2, expiring: 0, expired: 0, error: 0, orphan: 0 } };
      }
      throw new ApiError("database down", 500, "INTERNAL");
    });
    await vm.probeAll();
    await flushPromises();
    expect(ElMessage.error).toHaveBeenCalled();

    clock += 61_000;
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/environments")) return { items: [] };
      if (path.startsWith("/api/v1/connections")) return { items: [] };
      if (path.includes("/probe")) throw new Error("boom");
      if (path.startsWith("/api/v1/certificates")) {
        return { items: assets, summary: { total: 2, valid: 2, expiring: 0, expired: 0, error: 0, orphan: 0 } };
      }
      throw new Error("boom");
    });
    await vm.retryFailed();
    await flushPromises();
    expect(wrapper.get("[data-testid='certificate-batch-failures']").text()).toContain("boom");
    vi.restoreAllMocks();
    wrapper.unmount();
  });
});
