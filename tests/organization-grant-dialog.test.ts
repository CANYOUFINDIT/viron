/** @vitest-environment happy-dom */
import { defineComponent } from "vue";

vi.mock("../src/client/api", () => ({
  api: vi.fn(async () => ({})),
}));
import { flushPromises, mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import OrganizationGrantDialog from "../src/client/views/organization/OrganizationGrantDialog.vue";
import { provideOrganizationContext, type OrganizationContext } from "../src/client/views/organization/context";
import { i18nPlugin, language } from "../src/client/i18n";

const Host = defineComponent({
  props: { context: { type: Object, required: true } },
  setup(props) {
    provideOrganizationContext(props.context as OrganizationContext);
  },
  components: { OrganizationGrantDialog },
  template: "<OrganizationGrantDialog />",
});

function mountDialog(resources: Array<{ id: string; type: "environment_group" | "environment" | "ssh_connection" | "database_connection" | "redis_connection"; name: string; groupId?: string | null }> = [{ id: "env-1", type: "environment", name: "生产", groupId: "group-1" }]) {
  const saveGrant = vi.fn(async () => undefined);
  const context = {
    currentOrganizationId: ref("org-1"),
    editingGrant: ref(null),
    grantDialog: ref(true),
    grantingResource: ref(false),
    resources: ref(resources),
    saveGrant,
    selectedGrantTarget: ref({ id: "user-1", type: "user", name: "成员甲" }),
  };
  const wrapper = mount(Host, {
    props: { context },
    attachTo: document.body,
    global: { plugins: [ElementPlus, i18nPlugin] },
  });
  return { wrapper, saveGrant, context };
}

describe("organization grant dialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("checks the lighter actions when a heavier one is chosen and saves one duration", async () => {
    language.value = "zh-CN";
    const { wrapper, saveGrant } = mountDialog();
    await flushPromises();
    expect(document.body.textContent).toContain("授权资源");
    expect(document.body.textContent).toContain("环境与环境组");
    expect(document.body.textContent).not.toContain("查看并打开");

    const next = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "下一步") as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    const option = [...document.body.querySelectorAll("button")].find((item) => item.textContent?.includes("生产"));
    expect(option).toBeTruthy();
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(next.disabled).toBe(false);
    next.click();
    await flushPromises();
    expect(document.body.textContent).toContain("查看并打开");
    expect(document.body.textContent).toContain("8 小时");

    const manage = [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("编辑入口和账号"));
    expect(manage).toBeTruthy();
    const input = manage!.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    await flushPromises();

    const checked = [...document.body.querySelectorAll(".grant-matrix__row")]
      .find((row) => row.textContent?.includes("Web 入口"))
      ?.querySelectorAll("input:checked");
    expect(checked).toHaveLength(3);

    const save = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("确认授权")) as HTMLButtonElement;
    const forever = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "永久") as HTMLButtonElement;
    forever.click();
    await flushPromises();
    expect(save.disabled).toBe(false);
    save.click();
    await flushPromises();
    expect(saveGrant).toHaveBeenCalledWith(expect.objectContaining({
      scopeKind: "environment",
      targetIds: ["env-1"],
      permissions: expect.objectContaining({ web: ["view", "use", "manage"] }),
      expiresAt: null,
    }));
    wrapper.unmount();
  });

  it("authorizes a whole environment group from the overview list", async () => {
    language.value = "zh-CN";
    const { wrapper, saveGrant } = mountDialog([
      { id: "group-1", type: "environment_group", name: "default", groupId: null },
      { id: "env-1", type: "environment", name: "生产", groupId: "group-1" },
    ]);
    await flushPromises();
    const wholeGroup = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "整个组") as HTMLButtonElement;
    wholeGroup.click();
    await flushPromises();
    const next = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "下一步") as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    next.click();
    await flushPromises();
    expect(document.body.textContent).toContain("整个组使用同一套操作");
    const view = [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("查看并打开"));
    const input = view!.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    const forever = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "永久") as HTMLButtonElement;
    forever.click();
    await flushPromises();
    const save = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("确认授权")) as HTMLButtonElement;
    save.click();
    await flushPromises();
    expect(saveGrant).toHaveBeenCalledWith(expect.objectContaining({
      scopeKind: "environment_group",
      wholeGroup: true,
      groupId: "group-1",
      targetIds: [],
      expiresAt: null,
    }));
    wrapper.unmount();
  });

  it("authorizes several ssh connections from the workbench list", async () => {
    language.value = "zh-CN";
    const { wrapper, saveGrant } = mountDialog([
      { id: "ssh-1", type: "ssh_connection", name: "跳板机", groupId: null },
      { id: "ssh-2", type: "ssh_connection", name: "应用机", groupId: null },
    ]);
    await flushPromises();
    const sshTab = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "SSH 连接") as HTMLButtonElement;
    sshTab.click();
    await flushPromises();
    for (const name of ["跳板机", "应用机"]) {
      const row = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes(name));
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    await flushPromises();
    const next = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "下一步") as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    next.click();
    await flushPromises();
    const manage = [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("编辑连接"));
    const input = manage!.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    const forever = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "永久") as HTMLButtonElement;
    forever.click();
    await flushPromises();
    const save = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("确认授权")) as HTMLButtonElement;
    save.click();
    await flushPromises();
    expect(saveGrant).toHaveBeenCalledWith(expect.objectContaining({
      scopeKind: "ssh_connection",
      wholeGroup: false,
      groupId: null,
      targetIds: ["ssh-1", "ssh-2"],
      permissions: expect.objectContaining({ ssh: ["view", "use", "manage"] }),
      expiresAt: null,
    }));
    wrapper.unmount();
  });
});
