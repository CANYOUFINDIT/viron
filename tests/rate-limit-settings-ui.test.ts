// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import { describe, expect, it } from "vitest";
import RateLimitSettings from "../src/client/views/settings/RateLimitSettings.vue";
import { defaultApiRateLimitSettings } from "../src/shared/api-rate-limit-settings.js";

const global = { plugins: [ElementPlus], mocks: { $t: (key: string) => key } };

describe("administrator rate-limit form", () => {
  it("disables editable budgets when general limiting is off", () => {
    const wrapper = mount(RateLimitSettings, { props: { modelValue: { ...defaultApiRateLimitSettings(), enabled: false }, saving: false }, global });
    const budgets = wrapper.findAll('input[role="spinbutton"]');
    expect(budgets).toHaveLength(5);
    expect(budgets.every((input) => (input.element as HTMLInputElement).disabled)).toBe(true);
    expect(wrapper.text()).toContain("专项额度独立生效");
    wrapper.unmount();
  });

  it("restores the complete default policy in the draft", async () => {
    const wrapper = mount(RateLimitSettings, { props: { modelValue: { ...defaultApiRateLimitSettings(), enabled: false, userRequestsPerMinute: 5 }, saving: false }, global });
    await wrapper.get('button.el-button').trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([defaultApiRateLimitSettings()]);
    expect(wrapper.text()).toContain("恢复默认只修改当前表单");
    wrapper.unmount();
  });

  it("prevents edits while a save is in progress", () => {
    const wrapper = mount(RateLimitSettings, { props: { modelValue: defaultApiRateLimitSettings(), saving: true }, global });
    expect((wrapper.get('button.el-button').element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.findAll("input").every((input) => (input.element as HTMLInputElement).disabled)).toBe(true);
    wrapper.unmount();
  });
});
