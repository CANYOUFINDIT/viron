/** @vitest-environment happy-dom */
import { defineComponent } from "vue";

vi.mock("../src/client/api", () => ({
  api: vi.fn(async () => ({})),
}));
import { flushPromises, mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { api } from "../src/client/api";
import OrganizationGrantDialog from "../src/client/views/organization/OrganizationGrantDialog.vue";
import { provideOrganizationContext, type OrganizationContext } from "../src/client/views/organization/context";
import { i18nPlugin, language } from "../src/client/i18n";
import { CAPABILITIES, CAPABILITY_ACTIONS } from "../src/shared/access-permissions";

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
    grantRequestMode: ref(false),
    session: { user: { id: "user-1", username: "成员甲" } },
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
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.mocked(api).mockImplementation(async () => ({}));
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

    const webRow = [...document.body.querySelectorAll(".grant-matrix__row")].find((row) => row.textContent?.includes("Web 入口")) as HTMLElement;
    const actionInputs = [...webRow.querySelectorAll(".grant-matrix__actions input")] as HTMLInputElement[];
    expect(actionInputs.map((input) => input.checked)).toEqual([true, true, true]);
    expect((webRow.querySelector(".grant-action-all input") as HTMLInputElement).checked).toBe(true);

    const reason = document.body.querySelector('textarea[aria-label="操作原因"]') as HTMLTextAreaElement;
    reason.value = "生产排障";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
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

  it("keeps the start and end fields on their own row and submits both times", async () => {
    language.value = "zh-CN";
    const { wrapper, saveGrant } = mountDialog();
    await flushPromises();
    const option = [...document.body.querySelectorAll("button")].find((item) => item.textContent?.includes("生产"));
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    ([...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "下一步") as HTMLButtonElement).click();
    await flushPromises();
    expect(document.body.textContent).toContain("开始时间");
    expect(document.body.textContent).toContain("结束时间");
    expect(document.body.textContent).toContain("留空则立即生效");
    expect(document.body.querySelector("input[type='datetime-local']")).toBeNull();
    expect(document.body.querySelector(".grant-validity .grant-window")).toBeTruthy();

    const pickers = wrapper.findAllComponents({ name: "ElDatePicker" });
    expect(pickers).toHaveLength(2);
    await pickers[0].setValue?.("2026-10-05T09:00");
    pickers[0].vm.$emit("update:modelValue", "2026-10-05T09:00");
    pickers[0].vm.$emit("change", "2026-10-05T09:00");
    await pickers[1].vm.$emit("update:modelValue", "2026-10-05T18:00");
    pickers[1].vm.$emit("change", "2026-10-05T18:00");
    await flushPromises();

    const reason = document.body.querySelector('textarea[aria-label="操作原因"]') as HTMLTextAreaElement;
    reason.value = "生产排障";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    const view = [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("查看并打开"));
    const input = view!.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    await flushPromises();
    const save = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("确认授权")) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.click();
    await flushPromises();
    expect(saveGrant).toHaveBeenCalledWith(expect.objectContaining({
      startsAt: new Date("2026-10-05T09:00").toISOString(),
      expiresAt: new Date("2026-10-05T18:00").toISOString(),
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
    const reason = document.body.querySelector('textarea[aria-label="操作原因"]') as HTMLTextAreaElement;
    reason.value = "生产排障";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
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
    expect(document.body.querySelectorAll(".grant-matrix__row")).toHaveLength(1);
    const selectAll = document.body.querySelector(".grant-matrix__head .grant-action-all input") as HTMLInputElement;
    selectAll.checked = true;
    selectAll.dispatchEvent(new Event("change"));
    await flushPromises();
    expect([...document.body.querySelectorAll(".grant-matrix__actions input")].every((input) => (input as HTMLInputElement).checked)).toBe(true);
    const manage = [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("编辑连接"));
    const input = manage!.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    const forever = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "永久") as HTMLButtonElement;
    forever.click();
    await flushPromises();
    const reason = document.body.querySelector('textarea[aria-label="操作原因"]') as HTMLTextAreaElement;
    reason.value = "生产排障";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
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

  it("scopes a capability to named items grouped by environment", async () => {
    language.value = "zh-CN";
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes("grant-catalog")) {
        return {
          web: [
            { id: "web-1", name: "Nacos", environmentId: "env-1", environmentName: "开发环境" },
            { id: "web-2", name: "agione-算模方", environmentId: "env-2", environmentName: "Test" },
            { id: "web-3", name: "dev-harbor", environmentId: "env-2", environmentName: "Test" },
          ],
          ssh: [],
          logs: [],
          database: [],
          redis: [],
          knowledge: [],
          maintenance: [],
        };
      }
      return {};
    });
    const { wrapper, saveGrant } = mountDialog([
      { id: "env-1", type: "environment", name: "开发环境", groupId: "group-1" },
      { id: "env-2", type: "environment", name: "Test", groupId: "group-1" },
    ]);
    await flushPromises();
    for (const name of ["开发环境", "Test"]) {
      const option = [...document.body.querySelectorAll("button")].find((item) => item.textContent?.includes(name));
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    await flushPromises();
    const next = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "下一步") as HTMLButtonElement;
    next.click();
    await flushPromises();

    const webRow = [...document.body.querySelectorAll(".grant-matrix__row")].find((row) => row.textContent?.includes("Web 入口")) as HTMLElement;
    const view = [...webRow.querySelectorAll("label")].find((label) => label.textContent?.includes("查看并打开"));
    const input = view!.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    await flushPromises();

    expect(webRow.textContent).toContain("全部");
    expect(webRow.textContent).toContain("含新增");
    expect(webRow.textContent).toContain("已选全部 (3)");
    expect(webRow.textContent).not.toContain("这一整块");
    expect(webRow.textContent).not.toContain("只选其中几个");

    expect([...webRow.querySelectorAll(".grant-group-label span")].map((heading) => heading.textContent)).toEqual(["开发环境", "Test"]);
    const choices = [...webRow.querySelectorAll(".grant-item-list label:not(.grant-group-label)")].map((label) => label.textContent?.trim());
    expect(choices).toEqual(["Nacos", "agione-算模方", "dev-harbor"]);

    const allCheckbox = webRow.querySelector(".grant-scope-all input") as HTMLInputElement;
    expect(allCheckbox.checked).toBe(true);
    allCheckbox.checked = false;
    allCheckbox.dispatchEvent(new Event("change"));
    await flushPromises();

    expect(webRow.textContent).toContain("已选 0/3");
    expect(webRow.textContent).toContain("至少选一个");

    const nacos = [...webRow.querySelectorAll(".grant-item-list label:not(.grant-group-label)")].find((label) => label.textContent?.includes("Nacos"));
    const nacosInput = nacos!.querySelector("input") as HTMLInputElement;
    nacosInput.checked = true;
    nacosInput.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(nacos!.classList.contains("is-checked")).toBe(true);
    expect(webRow.textContent).toContain("已指定 1/3");
    expect(webRow.textContent).not.toContain("至少选一个");

    const forever = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "永久") as HTMLButtonElement;
    forever.click();
    await flushPromises();
    const reason = document.body.querySelector('textarea[aria-label="操作原因"]') as HTMLTextAreaElement;
    reason.value = "生产排障";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    const save = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("确认授权")) as HTMLButtonElement;
    save.click();
    await flushPromises();
    expect(saveGrant).toHaveBeenCalledWith(expect.objectContaining({
      scopeKind: "environment",
      targetIds: ["env-1", "env-2"],
      permissions: expect.objectContaining({ web: ["view"] }),
      items: { web: ["web-1"] },
    }));
    wrapper.unmount();
  });

  it("selects every visible action from the header and one capability from its row", async () => {
    language.value = "zh-CN";
    const { wrapper, saveGrant } = mountDialog();
    await flushPromises();
    const option = [...document.body.querySelectorAll("button")].find((item) => item.textContent?.includes("生产"));
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    const next = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "下一步") as HTMLButtonElement;
    next.click();
    await flushPromises();

    const header = document.body.querySelector(".grant-matrix__head .grant-action-all input") as HTMLInputElement;
    expect(header.checked).toBe(false);
    expect(header.indeterminate).toBe(false);
    expect(header.getAttribute("aria-label")).toBe("全选操作");

    const webRow = [...document.body.querySelectorAll(".grant-matrix__row")].find((row) => row.textContent?.includes("Web 入口")) as HTMLElement;
    const webAll = webRow.querySelector(".grant-action-all input") as HTMLInputElement;
    expect(webAll.getAttribute("aria-label")).toBe("全选Web 入口");
    webAll.checked = true;
    webAll.dispatchEvent(new Event("change"));
    await flushPromises();

    expect([...webRow.querySelectorAll(".grant-matrix__actions input")].every((input) => (input as HTMLInputElement).checked)).toBe(true);
    const sshRow = [...document.body.querySelectorAll(".grant-matrix__row")].find((row) => row.textContent?.includes("SSH 终端")) as HTMLElement;
    expect([...sshRow.querySelectorAll(".grant-matrix__actions input")].some((input) => (input as HTMLInputElement).checked)).toBe(false);
    expect(header.indeterminate).toBe(true);

    header.checked = true;
    header.dispatchEvent(new Event("change"));
    await flushPromises();
    const actionInputs = [...document.body.querySelectorAll(".grant-matrix__actions input")] as HTMLInputElement[];
    expect(actionInputs.every((input) => input.checked)).toBe(true);
    expect(header.checked).toBe(true);
    expect(header.indeterminate).toBe(false);

    header.checked = false;
    header.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(actionInputs.every((input) => !input.checked)).toBe(true);

    header.checked = true;
    header.dispatchEvent(new Event("change"));
    await flushPromises();
    const reason = document.body.querySelector('textarea[aria-label="操作原因"]') as HTMLTextAreaElement;
    reason.value = "生产排障";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    const save = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("确认授权")) as HTMLButtonElement;
    save.click();
    await flushPromises();
    expect(saveGrant).toHaveBeenCalledWith(expect.objectContaining({
      permissions: Object.fromEntries(CAPABILITIES.map((capability) => [capability, [...CAPABILITY_ACTIONS[capability]]])),
      items: {},
    }));
    wrapper.unmount();
  });
});
