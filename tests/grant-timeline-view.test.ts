/** @vitest-environment happy-dom */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GrantTimelineView from "../src/client/views/organization/GrantTimelineView.vue";
import { i18nPlugin, language } from "../src/client/i18n";

const now = Date.parse("2026-10-02T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (offset: number) => new Date(now + offset).toISOString();

function renderTimeline() {
  return mount(GrantTimelineView, {
    props: {
      rows: [
        { grant: { id: "old", resourceId: "长期授权", createdAt: iso(-60 * DAY), expiresAt: null, expired: false }, source: "示例项目", inherited: false },
        { grant: { id: "soon", resourceId: "当日授权", createdAt: iso(-DAY), expiresAt: iso(8 * 3_600_000), expired: false }, source: "示例项目", inherited: false },
      ],
      selectedNodeType: "organization",
    },
    global: {
      plugins: [i18nPlugin],
      stubs: {
        "el-tooltip": { template: "<div><slot /></div>" },
        "el-date-picker": { props: ["modelValue"], emits: ["update:modelValue"], template: '<div class="date-picker" />' },
      },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  language.value = "zh-CN";
});

afterEach(() => vi.useRealTimers());

describe("grant timeline range controls", () => {
  it("starts at seven days and changes the axis while preserving the active status filter", async () => {
    const wrapper = renderTimeline();
    const initialTicks = wrapper.findAll(".trace-tick").map((tick) => tick.text());
    expect((wrapper.get("select").element as HTMLSelectElement).value).toBe("7");
    await wrapper.get(".trace-chip.is-soon").trigger("click");
    await wrapper.get("select").setValue("30");
    expect(wrapper.findAll(".trace-row")).toHaveLength(1);
    expect(wrapper.get(".trace-row").text()).toContain("当日授权");
    expect(wrapper.findAll(".trace-tick").map((tick) => tick.text())).not.toEqual(initialTicks);
    expect(wrapper.get(".trace-chip.is-soon").classes()).toContain("is-active");
    wrapper.unmount();
  });

  it("applies a custom historical range and restores it when returning from a preset", async () => {
    const wrapper = renderTimeline();
    await wrapper.get("select").setValue("30");
    const thirtyDayTicks = wrapper.findAll(".trace-tick").map((tick) => tick.text());
    await wrapper.get("select").setValue("custom");
    expect(wrapper.findAll(".trace-tick").map((tick) => tick.text())).toEqual(thirtyDayTicks);

    const picker = wrapper.getComponent(".date-picker");
    picker.vm.$emit("update:modelValue", [new Date(now - 10 * DAY), new Date(now - 9 * DAY)]);
    await wrapper.get(".trace-range-apply").trigger("click");
    expect(wrapper.find(".trace-now-layer").exists()).toBe(false);
    expect(wrapper.get(".trace-outside.is-after").text()).toBe("晚于当前范围 →");
    expect(wrapper.findAll(".trace-row")).toHaveLength(2);
    const historicalTicks = wrapper.findAll(".trace-tick").map((tick) => tick.text());
    await wrapper.get("select").setValue("7");
    expect(wrapper.find(".trace-now-layer").exists()).toBe(true);
    await wrapper.get("select").setValue("custom");
    expect(wrapper.findAll(".trace-tick").map((tick) => tick.text())).toEqual(historicalTicks);
    wrapper.unmount();
  });

  it("keeps the applied range when dates are cleared or reversed", async () => {
    const wrapper = renderTimeline();
    await wrapper.get("select").setValue("custom");
    const initialTicks = wrapper.findAll(".trace-tick").map((tick) => tick.text());
    const picker = wrapper.getComponent(".date-picker");
    for (const value of [null, [new Date(now + DAY), new Date(now - DAY)]]) {
      picker.vm.$emit("update:modelValue", value);
      await wrapper.vm.$nextTick();
      expect(wrapper.get(".trace-range-apply").attributes("disabled")).toBeDefined();
      expect(wrapper.findAll(".trace-tick").map((tick) => tick.text())).toEqual(initialTicks);
    }
    wrapper.unmount();
  });

  it("provides the full authorization history on request", async () => {
    const wrapper = renderTimeline();
    await wrapper.get("select").setValue("all");
    expect(wrapper.find(".trace-custom-range").exists()).toBe(false);
    expect(wrapper.findAll(".trace-row")).toHaveLength(2);
    expect(wrapper.get(".trace-tick.is-start").text()).toMatch(/8\/\d+/);
    wrapper.unmount();
  });
});
