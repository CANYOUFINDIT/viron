/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/desktop", () => ({ isDesktopApp: () => false, desktopState: vi.fn() }));
vi.mock("../src/client/i18n", () => ({ translate: (message: string) => message }));
vi.mock("../src/client/session", async () => {
  const { reactive } = await import("vue");
  return { session: reactive({ workspace: null, workspaces: [], user: null }), loadSession: vi.fn(), switchWorkspace: vi.fn() };
});
vi.mock("element-plus", () => ({ ElMessage: { error: vi.fn(), warning: vi.fn() }, ElMessageBox: {} }));
import { api } from "../src/client/api";
import { session } from "../src/client/session";
import { useOrganizationController } from "../src/client/views/organization/use-organization-controller";
const org = { id: "org-1", name: "示例组织", type: "organization", role: "admin", permissionCodes: ["organization.update"] } as const;
const detail = { organization: org, projects: [], members: [], grants: [] };
const wrappers: ReturnType<typeof mount>[] = [];
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mountController() {
  let context!: ReturnType<typeof useOrganizationController>;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: { render: () => h("div") } }] });
  await router.push("/");
  const wrapper = mount(defineComponent({ setup() { context = useOrganizationController(); return () => h("div"); } }), { global: { plugins: [router] } });
  wrappers.push(wrapper);
  await flushPromises();
  return context;
}
beforeEach(() => {
  vi.mocked(api).mockReset();
  session.workspace = { ...org };
  session.workspaces = [{ ...org }];
  session.user = { id: "user-1", username: "测试成员", isPlatformAdmin: true, createdAt: "" };
  vi.mocked(api).mockImplementation(async path => path === "/api/v1/organizations" ? { items: [org] } : detail);
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers(); });
describe("organization loading boundaries", () => {
  it("renders detail before a slow list and does not fetch unrelated datasets", async () => {
    const list = deferred<unknown>();
    vi.mocked(api).mockImplementation(async path => path === "/api/v1/organizations" ? list.promise : detail);
    const context = await mountController();
    expect(context.detail.value).toEqual(detail);
    expect(context.loading.value).toBe(false);
    expect(context.organizations.value[0]?.name).toBe("示例组织");
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(["/api/v1/organizations", "/api/v1/organizations/org-1"]);
    list.reject(new Error("组织列表暂时不可用"));
    await flushPromises();
    expect(context.detail.value).toEqual(detail);
    expect(context.loadError.value).toBe("组织列表暂时不可用");
  });
  it("ignores responses from the previous organization when the workspace changes", async () => {
    const oldDetail = deferred<unknown>();
    vi.mocked(api).mockImplementation(async path => path === "/api/v1/organizations" ? { items: [org] } : path.endsWith("org-1") ? oldDetail.promise : { ...detail, organization: { ...org, id: "org-2", name: "新组织" } });
    const context = await mountController();
    session.workspace = { ...org, id: "org-2", name: "新组织" };
    await nextTick(); await flushPromises();
    oldDetail.resolve(detail); await flushPromises();
    expect(context.detail.value?.organization.name).toBe("新组织");
    expect(context.selectedNode.value.id).toBe("org-2");
    expect(context.loading.value).toBe(false);
  });
  it("ends a stalled request with a recoverable error after the deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockImplementation((_path, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }); }));
    const context = await mountController();
    expect(context.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); await flushPromises();
    expect(context.loading.value).toBe(false);
    expect(context.loadError.value).toContain("超时");
    expect(context.detail.value).toBeNull();
  });
});
