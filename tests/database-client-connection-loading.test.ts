/** @vitest-environment happy-dom */
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/client/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/client/api")>(),
  api: vi.fn(),
}));
vi.mock("../src/client/components/TableDataEditor.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../src/client/components/SqlEditor.vue", () => ({ default: { template: "<div />" } }));
import { api } from "../src/client/api";
import DatabaseWorkbench from "../src/client/components/DatabaseWorkbench.vue";
import { i18nPlugin } from "../src/client/i18n";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("database connection readiness", () => {
  it("makes the database usable while optional history is still loading", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
    let resolveHistory!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith("/api/v1/connections?")) return { items: [{ id: "fixture", name: "Fixture", host: "database.example", port: 3306, username: "fixture", engine: "mysql", options: {} }] };
      if (path === "/api/v1/database-sessions") return { item: { id: "session" } };
      if (path.endsWith("/schemas")) return { items: [{ name: "fixture" }] };
      if (path.startsWith("/api/v1/database-query-history?")) return new Promise((resolve) => { resolveHistory = resolve; });
      return { items: [] };
    });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/database", component: DatabaseWorkbench }] });
    await router.push("/database");
    const setLoading = (element: HTMLElement, binding: { value: unknown }) => element.setAttribute("data-loading", String(binding.value));
    const wrapper = shallowMount(DatabaseWorkbench, {
      props: { initialConnectionId: "fixture", active: true },
      global: { plugins: [router, i18nPlugin], directives: { loading: { mounted: setLoading, updated: setLoading } } },
    });
    try {
      await flushPromises();
      expect(resolveHistory).toBeTypeOf("function");
      expect(wrapper.find(".schema-node").text()).toBe("fixture");
      expect(wrapper.get(".database-workbench").attributes("data-loading")).toBe("false");
      resolveHistory({ items: [] });
      await flushPromises();
    } finally {
      wrapper.unmount();
    }
  });
});
