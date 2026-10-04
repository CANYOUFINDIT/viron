/** @vitest-environment happy-dom */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GrantTimelineView from "../src/client/views/organization/GrantTimelineView.vue";
import type { GrantRowItem } from "../src/client/views/organization/GrantTimelineView.vue";
import { i18nPlugin, language } from "../src/client/i18n";

const now = Date.parse("2026-10-02T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (offset: number) => new Date(now + offset).toISOString();

const defaultRows: GrantRowItem[] = [
  { grant: { id: "old", resourceId: "长期授权", createdAt: iso(-60 * DAY), expiresAt: null, expired: false }, source: "示例项目", inherited: false },
  { grant: { id: "soon", resourceId: "当日授权", createdAt: iso(-DAY), expiresAt: iso(8 * 3_600_000), expired: false }, source: "示例项目", inherited: false },
];

function renderTimeline(rows: GrantRowItem[] = defaultRows) {
  return mount(GrantTimelineView, {
    props: {
      rows,
      selectedNodeType: "organization",
    },
    global: {
      plugins: [i18nPlugin],
      stubs: {
        "el-tooltip": { template: '<div><slot /><div class="tooltip-content"><slot name="content" /></div></div>' },
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

describe("grant timeline details", () => {
  it("shows exact in-range start and end times in the ruler for the hovered grant", async () => {
    const wrapper = renderTimeline();
    const soon = wrapper.get(".trace-row.is-soon");
    expect(wrapper.findAll(".trace-boundary-label")).toHaveLength(0);
    await soon.trigger("mouseenter");
    expect(wrapper.get(".trace-ruler-label strong").text()).toBe("当日授权");
    const boundaries = wrapper.findAll(".trace-boundary-label");
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0].get("time").attributes("datetime")).toBe(iso(-DAY));
    expect(boundaries[1].get("time").attributes("datetime")).toBe(iso(8 * 3_600_000));
    for (const boundary of boundaries) expect(boundary.text()).toMatch(/\d+\/\d+ \d{2}:\d{2}/);
    await soon.trigger("mouseleave");
    expect(wrapper.findAll(".trace-boundary-label")).toHaveLength(0);
    wrapper.unmount();
  });

  it("omits clipped endpoints and permanent end dates, and updates when the span changes", async () => {
    const wrapper = renderTimeline();
    await wrapper.get(".trace-row.is-forever").trigger("mouseenter");
    expect(wrapper.findAll(".trace-boundary-label")).toHaveLength(0);
    await wrapper.get("select").setValue("all");
    expect(wrapper.findAll(".trace-boundary-label")).toHaveLength(1);
    expect(wrapper.get(".trace-boundary-label").classes()).toContain("is-start");
    expect(wrapper.get(".trace-boundary-label time").attributes("datetime")).toBe(iso(-60 * DAY));
    await wrapper.get(".trace-row.is-soon").trigger("mouseenter");
    await wrapper.get("select").setValue("custom");
    wrapper.getComponent(".date-picker").vm.$emit("update:modelValue", [new Date(now), new Date(now + DAY)]);
    await wrapper.get(".trace-range-apply").trigger("click");
    expect(wrapper.findAll(".trace-boundary-label")).toHaveLength(1);
    expect(wrapper.get(".trace-boundary-label").classes()).toContain("is-end");
    wrapper.unmount();
  });

  it("marks both range edges and supports keyboard focus across row actions", async () => {
    const wrapper = renderTimeline([{
      grant: { id: "edges", resourceId: "范围边界", createdAt: iso(-20 * DAY), startsAt: iso(-2 * DAY), expiresAt: iso(5 * DAY), expired: false },
      source: "示例项目", inherited: false,
    }]);
    const row = wrapper.get(".trace-row");
    await row.trigger("focusin");
    expect(wrapper.get(".trace-boundary-mark.is-start").attributes("style")).toContain("left: 0%");
    expect(wrapper.get(".trace-boundary-mark.is-end").attributes("style")).toContain("left: 100%");
    await row.trigger("focusout", { relatedTarget: row.get("button").element });
    expect(wrapper.findAll(".trace-boundary-label")).toHaveLength(2);
    await row.trigger("focusout", { relatedTarget: wrapper.get("select").element });
    expect(wrapper.findAll(".trace-boundary-label")).toHaveLength(0);
    wrapper.unmount();
  });

  it("displays the full permission scope separately from its inherited source", () => {
    const permissionText = "Web 入口：查看并打开、使用；服务器：查看、终端连接、文件管理；数据库：查询、执行 SQL、结构管理";
    const wrapper = renderTimeline([{
      grant: { id: "scope", resourceId: "测试资源", createdAt: iso(-DAY), expiresAt: null, expired: false, permissionText },
      source: "上级项目", inherited: true,
    }]);
    expect(wrapper.get(".trace-scope").text()).toBe(permissionText);
    expect(wrapper.get(".trace-source").text()).toBe("继承自 上级项目");
    expect(wrapper.get(".chrono-hud-metric--scope span").text()).toBe(permissionText);
    wrapper.unmount();
  });
});
