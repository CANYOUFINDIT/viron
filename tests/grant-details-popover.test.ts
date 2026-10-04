/** @vitest-environment happy-dom */
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GrantDetailsPopover from "../src/client/views/organization/GrantDetailsPopover.vue";
import { i18nPlugin, language } from "../src/client/i18n";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/client/api", () => ({ api: request }));

function renderDetails() {
  return mount(GrantDetailsPopover, {
    props: {
      grant: { resourceId: "env-1", label: "示例环境", scopeKind: "environment", targetIds: ["env-1"], permissions: { web: ["view"], ssh: ["manage"] }, items: { web: ["web-2"] } },
      source: "示例项目", status: "永久有效", tone: "forever", start: Date.parse("2026-10-04T02:00:00Z"), end: null, organizationId: "org-1",
    },
    slots: { default: "<article>资源名称 · 授权范围</article>" },
    global: {
      plugins: [i18nPlugin],
      stubs: { "el-popover": { name: "el-popover", emits: ["show", "hide"], template: '<div><slot name="reference" /><slot /></div>' } },
    },
  });
}

beforeEach(() => { request.mockReset(); language.value = "zh-CN"; });

describe("structured grant popover", () => {
  it("loads scope names on hover, caches them, and keeps selected operations and items accurate", async () => {
    request.mockResolvedValue({ web: [{ id: "web-1", name: "未授权入口" }, { id: "web-2", name: "授权入口" }], ssh: [{ id: "ssh-1", name: "授权主机" }] });
    const wrapper = renderDetails();
    expect(request).not.toHaveBeenCalled();
    wrapper.getComponent({ name: "el-popover" }).vm.$emit("show");
    await flushPromises();
    expect(request).toHaveBeenCalledWith("/api/v1/organizations/org-1/access-request-catalog?environmentIds=env-1");
    const web = wrapper.get('[data-capability="web"]');
    expect(web.get(".grant-details__scope-head").text()).toContain("指定资源");
    expect(web.get(".grant-details__items").text()).toBe("授权入口");
    expect(web.findAll(".grant-details__action.is-selected")).toHaveLength(1);
    expect(wrapper.get('[data-capability="ssh"] .grant-details__future').text()).toBe("含新增");
    wrapper.getComponent({ name: "el-popover" }).vm.$emit("show");
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("lets the user retry a failed scope load", async () => {
    request.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ web: [{ id: "web-2", name: "恢复的入口" }] });
    const wrapper = renderDetails();
    wrapper.getComponent({ name: "el-popover" }).vm.$emit("show");
    await flushPromises();
    expect(wrapper.text()).toContain("范围明细加载失败");
    await wrapper.get(".grant-details__note button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("恢复的入口");
    expect(wrapper.text()).not.toContain("范围明细加载失败");
    wrapper.unmount();
  });

  it("ignores an old response after switching to another organization and scope", async () => {
    let resolveOld!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce({ web: [{ id: "web-2", name: "新组织入口" }] });
    const wrapper = renderDetails();
    wrapper.getComponent({ name: "el-popover" }).vm.$emit("show");
    await wrapper.setProps({ organizationId: "org-2" });
    await flushPromises();
    resolveOld({ web: [{ id: "web-2", name: "旧组织入口" }] });
    await flushPromises();
    expect(wrapper.text()).toContain("新组织入口");
    expect(wrapper.text()).not.toContain("旧组织入口");
    wrapper.unmount();
  });
});
