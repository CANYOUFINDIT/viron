// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { reactive } from "vue";
import ElementPlus from "element-plus";
import { describe, expect, it } from "vitest";
import WebLoginSettings from "../src/client/components/WebLoginSettings.vue";
import WebLoginNotice from "../src/client/components/WebLoginNotice.vue";
import { defaultWebLoginConfig } from "../src/shared/protected-web-login.js";

const global = { plugins: [ElementPlus], mocks: { $t: (key: string) => key } };
describe("Web login administrator settings", () => {
  it("defaults to protected login and switches the visible controls without discarding the protected recipe", async () => {
    const config = reactive({ ...defaultWebLoginConfig(), successSelector: "#success" });
    const wrapper = mount(WebLoginSettings, { props: { modelValue: config, stepsText: "", originsText: "" }, global });
    expect(wrapper.get("summary").text()).toBe("高级配置");
    expect((wrapper.get('input[value="protected"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.text()).toContain("打开正常网页"); expect(wrapper.text()).toContain("登录成功标记");
    await wrapper.get('input[value="locked"]').setValue(true);
    expect(config.mode).toBe("locked"); expect(wrapper.text()).toContain("填充并锁定密码");
    expect(wrapper.text()).toContain("禁用浏览器扩展和开发者工具");
    expect(wrapper.text()).not.toContain("登录成功标记"); expect(wrapper.text()).toContain("密码选择器");
    await wrapper.get('input[value="direct"]').setValue(true);
    expect(config.mode).toBe("direct"); expect(wrapper.text()).toContain("开发者工具或浏览器插件查看");
    expect(wrapper.text()).toContain("用户名选择器"); expect(wrapper.text()).toContain("密码选择器");
    expect(wrapper.text()).not.toContain("登录成功标记"); expect(wrapper.text()).not.toContain("多步登录脚本");
    await wrapper.get('input[value="protected"]').setValue(true);
    expect(config.successSelector).toBe("#success"); expect(wrapper.text()).toContain("多步登录脚本");
    wrapper.unmount();
  });
  it("labels a direct-fill retry without claiming that the account was logged in", () => {
    const wrapper = mount(WebLoginNotice, { props: { mode: "direct", message: "Fill unavailable" }, global });
    expect(wrapper.text()).toContain("重新填充"); expect(wrapper.text()).not.toContain("重试自动登录"); wrapper.unmount();
  });
});
