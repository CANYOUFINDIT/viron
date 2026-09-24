/** @vitest-environment happy-dom */
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/client/api")>(),
  api: vi.fn(async () => ({ items: [] })),
}));
vi.mock("../src/client/components/TableDataEditor.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../src/client/components/SqlEditor.vue", () => ({ default: { template: "<div />" } }));

import DatabaseWorkbench from "../src/client/components/DatabaseWorkbench.vue";
import { i18nPlugin } from "../src/client/i18n";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("database navigation restore", () => {
  it("shows a left-side restore button after collapsing the navigator", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/database", component: DatabaseWorkbench }] });
    await router.push("/database");
    const wrapper = shallowMount(DatabaseWorkbench, {
      props: { active: false },
      global: { plugins: [router, i18nPlugin], directives: { loading: () => undefined } },
    });
    try {
      await flushPromises();
      expect(wrapper.find(".database-navigator").exists()).toBe(true);
      await wrapper.get('[data-navicat-action="navigation-pane"]').trigger("click");
      expect(wrapper.find(".database-navigator").exists()).toBe(false);
      const restore = wrapper.get(".query-tabs .database-navigation-restore");
      expect(restore.attributes("aria-label")).toBeTruthy();
      await restore.trigger("click");
      expect(wrapper.find(".database-navigator").exists()).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });
});
