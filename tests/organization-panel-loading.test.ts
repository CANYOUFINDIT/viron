/** @vitest-environment happy-dom */
import { flushPromises, shallowMount } from "@vue/test-utils";
import { h, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client/api", () => ({ api: vi.fn() }));
vi.mock("../src/client/views/organization/context", () => ({ useOrganizationContext: () => context }));
vi.mock("../src/client/session", () => ({ workspaceCan: () => false, loadSession: vi.fn() }));
import { api } from "../src/client/api";
import MinePanel from "../src/client/views/organization/OrganizationMinePanel.vue";
import RolesPanel from "../src/client/views/organization/OrganizationRolesPanel.vue";
import ApprovalPanel from "../src/client/views/organization/OrganizationApprovalPanel.vue";
const context = {
  currentOrganizationId: ref("org-1"), activePanel: ref("mine"), dataRevision: ref(0),
  detail: ref({ organization: { name: "示例组织" }, members: [], projects: [] }),
  session: { user: { username: "示例成员" }, workspace: { name: "示例组织" } },
};
const wrappers: ReturnType<typeof shallowMount>[] = [];
const global = {
  directives: { loading: () => {} }, mocks: { $t: (text: string) => text },
  stubs: {
    ...Object.fromEntries(["ElDialog", "ElCheckbox", "ElRadio", "ElRadioGroup", "ElInputNumber", "ElOption", "ElSelect", "ElInput", "ElTable", "ElTableColumn", "ElAlert", "ElForm", "ElFormItem", "ElSwitch", "ElDatePicker", "ElTabs", "ElTabPane"].map(name => [name, true])),
    ElButton: { setup(_props: unknown, { slots }: { slots: { default?: () => unknown } }) { return () => h("button", slots.default?.()); } },
  },
};
const paths = () => vi.mocked(api).mock.calls.map(([path]) => path);
const emptyAccess = { roles: [], dataGrants: [], featureGrants: [] };
function mountPanel(component: typeof MinePanel | typeof RolesPanel | typeof ApprovalPanel) {
  const wrapper = shallowMount(component, { global });
  wrappers.push(wrapper);
  return wrapper;
}
beforeEach(() => {
  context.currentOrganizationId.value = "org-1";
  context.activePanel.value = "mine";
  context.dataRevision.value = 0;
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path) => path.endsWith("/my-access") ? emptyAccess : path.endsWith("/role-access") ? { ...emptyAccess, assignments: [], capabilities: {}, resourceCapabilities: {} } : { items: [], catalog: [], roles: [], unassigned: [] });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
describe("organization panels load the visible dataset", () => {
  it("does not wait for requests or approval flows to show personal access", async () => {
    mountPanel(MinePanel);
    await flushPromises();
    expect(paths()).toEqual(["/api/v1/organizations/org-1/my-access"]);
    context.activePanel.value = "todo";
    await flushPromises();
    expect(paths()).toEqual(["/api/v1/organizations/org-1/my-access", "/api/v1/organizations/org-1/grant-requests?view=todo&summary=1"]);
  });
  it("fetches request options when the feature request dialog opens", async () => {
    const wrapper = mountPanel(MinePanel);
    await flushPromises();
    const button = wrapper.findAll("button").find(button => button.text() === "申请功能授权")!;
    await button.trigger("click");
    await flushPromises();
    expect(paths()).toEqual(["/api/v1/organizations/org-1/my-access", "/api/v1/organizations/org-1/approval-flows"]);
  });
  it("shows roles without fetching the resource catalog", async () => {
    mountPanel(RolesPanel);
    await flushPromises();
    expect(paths()).toEqual(["/api/v1/organizations/org-1/role-access"]);
  });
  it("loads each approval tab independently", async () => {
    const wrapper = mountPanel(ApprovalPanel);
    await flushPromises();
    expect(paths()).toEqual(["/api/v1/organizations/org-1/approval-flows"]);
    await wrapper.get(".access-switch button:nth-child(2)").trigger("click");
    await flushPromises();
    expect(paths().at(-1)).toBe("/api/v1/organizations/org-1/grant-requests?view=all&summary=1");
    expect(paths()).toHaveLength(2);
    await wrapper.get(".access-switch button:nth-child(3)").trigger("click");
    await flushPromises();
    expect(paths().at(-1)).toBe("/api/v1/organizations/org-1/grant-ledger");
    expect(paths()).toHaveLength(3);
  });
  it("ignores a slow personal-access response after switching organizations", async () => {
    let finish!: (value: typeof emptyAccess) => void;
    vi.mocked(api).mockImplementation(path => path.includes("org-1/my-access") ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(emptyAccess));
    const wrapper = mountPanel(MinePanel);
    await flushPromises();
    context.currentOrganizationId.value = "org-2";
    await flushPromises();
    finish({ ...emptyAccess, roles: [{ id: "old", name: "旧组织角色" }] as never[] });
    await flushPromises();
    expect(wrapper.text()).not.toContain("旧组织角色");
  });
});
