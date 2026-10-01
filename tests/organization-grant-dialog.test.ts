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

function mountDialog() {
  const saveGrant = vi.fn(async () => undefined);
  const context = {
    currentOrganizationId: ref("org-1"),
    editingGrant: ref(null),
    grantDialog: ref(true),
    grantingResource: ref(false),
    resources: ref([{ id: "env-1", type: "environment", name: "生产", groupId: "group-1" }]),
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
    expect(save.disabled).toBe(true);

    const option = [...document.body.querySelectorAll("li, .el-select-dropdown__item, span")].find((item) => item.textContent === "生产");
    expect(option).toBeTruthy();
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
});
