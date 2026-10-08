/** @vitest-environment happy-dom */
import { flushPromises, shallowMount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktopMode = vi.hoisted(() => ({ enabled: false }));
vi.mock("../src/client/api", () => ({ api: vi.fn(), prefetchApi: vi.fn() }));
vi.mock("../src/client/session", () => ({ session: { workspace: { role: "owner" } } }));
vi.mock("../src/client/desktop", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/client/desktop")>(),
  isDesktopApp: () => desktopMode.enabled,
  desktopState: vi.fn(),
}));

import { api } from "../src/client/api";
import { desktopAppState } from "../src/client/desktop";
import { i18nPlugin } from "../src/client/i18n";
import { immersiveModeKey } from "../src/client/immersive-mode";
import EnvironmentDetailView from "../src/client/views/EnvironmentDetailView.vue";

const mockedApi = vi.mocked(api);
const wrappers: VueWrapper[] = [];
const account = (id: string) => ({ id, username: id, note: "", customFields: {}, hasPassword: true });
const accounts = { "site-a": [account("a-1"), account("a-2")], "site-b": [account("b-1"), account("b-2")] };
type AccountResponse = { items: ReturnType<typeof account>[] };
let requestAccounts: (entryId: keyof typeof accounts) => Promise<AccountResponse>;

const Browser = defineComponent({
  props: ["credentialId", "active"],
  setup() { return { page: ref("first page") }; },
  template: '<div class="browser-fixture"><button @click="page = \'second page\'">Next page</button><span>{{ page }}</span></div>',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function mountEnvironment(query: Record<string, string> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ name: "environment", path: "/environments/:id", component: EnvironmentDetailView }],
  });
  await router.push({ name: "environment", params: { id: "env-1" }, query });
  const wrapper = shallowMount(EnvironmentDetailView, {
    props: { environmentId: "env-1", preview: true },
    global: {
      plugins: [router, i18nPlugin],
      provide: { [immersiveModeKey as symbol]: { active: ref(false), setActive: vi.fn() } },
      directives: { loading: () => undefined },
      stubs: {
        WebAccountBrowser: Browser,
        DesktopWebAccountBrowser: Browser,
        "el-dialog": true, "el-button": true, "el-form": true, "el-form-item": true,
        "el-input": true, "el-select": true, "el-option": true,
      },
    },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

function selectedAccount(wrapper: VueWrapper) {
  const selected = wrapper.find(".web-account-row.is-selected");
  return selected.exists() ? selected.attributes("data-tab-id") : undefined;
}

function browser(wrapper: VueWrapper, credentialId: string) {
  return wrapper.findAllComponents(Browser).find((component) => component.props("credentialId") === credentialId)!;
}

async function selectSite(wrapper: VueWrapper, entryId: string) {
  await wrapper.get(`.resource-list__item[data-tab-id="${entryId}"]`).trigger("click");
}

async function selectAccount(wrapper: VueWrapper, credentialId: string) {
  await wrapper.get(`.web-account-row[data-tab-id="${credentialId}"] .web-account-row__main`).trigger("click");
}

beforeEach(() => {
  mockedApi.mockReset();
  desktopMode.enabled = false;
  desktopAppState.value = null;
  vi.restoreAllMocks();
  requestAccounts = async (entryId) => ({ items: accounts[entryId] });
  mockedApi.mockImplementation(async (path) => {
    if (path === "/api/v1/environments/env-1") return { item: { id: "env-1", name: "Test environment", tags: [], updatedAt: "2026-10-08", webCount: 3 } };
    if (path === "/api/v1/environments/env-1/web-entries") return { items: ["site-a", "site-b", "site-empty"].map((id) => ({ id, name: id, url: `https://${id}.example`, tags: [], credentialCount: id === "site-empty" ? 0 : 2 })) };
    if (path === "/api/v1/web-entries/site-empty/credentials") return { items: [] };
    const entryId = path.match(/^\/api\/v1\/web-entries\/(site-[ab])\/credentials$/)?.[1] as keyof typeof accounts | undefined;
    if (entryId) return requestAccounts(entryId);
    if (path.endsWith("/favicon")) return { dataUrl: null };
    return { items: [] };
  });
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  desktopAppState.value = null;
});

describe("website account selection", () => {
  it.each([false, true])("restores each site's last account and its page before refresh completes (desktop=%s)", async (desktop) => {
    desktopMode.enabled = desktop;
    if (desktop) desktopAppState.value = { executionMode: "local", capabilities: { desktopLocal: { web: true } } } as typeof desktopAppState.value;
    const wrapper = await mountEnvironment();
    await selectAccount(wrapper, "a-2");
    const originalBrowser = browser(wrapper, "a-2").element;
    await browser(wrapper, "a-2").get("button").trigger("click");
    await selectSite(wrapper, "site-b");
    await flushPromises();
    await selectAccount(wrapper, "b-2");

    const refresh = deferred<AccountResponse>();
    requestAccounts = (entryId) => entryId === "site-a" ? refresh.promise : Promise.resolve({ items: accounts[entryId] });
    await selectSite(wrapper, "site-a");
    expect(selectedAccount(wrapper)).toBe("a-2");
    expect(wrapper.find(".web-view-pane__empty").exists()).toBe(false);
    expect(browser(wrapper, "a-2").props("active")).toBe(true);
    expect(browser(wrapper, "a-2").element).toBe(originalBrowser);
    expect(browser(wrapper, "a-2").text()).toContain("second page");
    refresh.resolve({ items: accounts["site-a"] });
    await flushPromises();
    expect(selectedAccount(wrapper)).toBe("a-2");

    await selectSite(wrapper, "site-b");
    await flushPromises();
    expect(selectedAccount(wrapper)).toBe("b-2");
    await selectSite(wrapper, "site-b");
    expect(selectedAccount(wrapper)).toBe("b-2");
  });

  it("ignores responses for a website that is no longer selected", async () => {
    const wrapper = await mountEnvironment();
    await selectAccount(wrapper, "a-2");
    const old = deferred<AccountResponse>();
    requestAccounts = (entryId) => entryId === "site-b" ? old.promise : Promise.resolve({ items: accounts[entryId] });
    await selectSite(wrapper, "site-b");
    await selectSite(wrapper, "site-a");
    await flushPromises();
    old.resolve({ items: accounts["site-b"] });
    await flushPromises();
    expect(wrapper.findAll(".web-account-row").map((row) => row.attributes("data-tab-id"))).toEqual(["a-1", "a-2"]);
    expect(selectedAccount(wrapper)).toBe("a-2");
    expect(browser(wrapper, "a-2").props("active")).toBe(true);
  });

  it("ignores an older response even after switching back to the same website", async () => {
    const wrapper = await mountEnvironment();
    await selectAccount(wrapper, "a-2");
    await selectSite(wrapper, "site-b");
    await flushPromises();
    const old = deferred<AccountResponse>();
    const current = deferred<AccountResponse>();
    let requests = 0;
    requestAccounts = (entryId) => entryId === "site-a" ? (++requests === 1 ? old.promise : current.promise) : Promise.resolve({ items: accounts[entryId] });
    await selectSite(wrapper, "site-a");
    await selectSite(wrapper, "site-b");
    await selectSite(wrapper, "site-a");
    current.resolve({ items: accounts["site-a"] });
    await flushPromises();
    old.resolve({ items: [account("a-1")] });
    await flushPromises();
    expect(selectedAccount(wrapper)).toBe("a-2");
    expect(browser(wrapper, "a-2").props("active")).toBe(true);
  });

  it("falls back when the remembered account was deleted, and handles an empty website", async () => {
    const wrapper = await mountEnvironment();
    await selectAccount(wrapper, "a-2");
    await selectSite(wrapper, "site-empty");
    await flushPromises();
    expect(selectedAccount(wrapper)).toBeUndefined();
    expect(wrapper.find(".web-view-pane__empty").exists()).toBe(true);
    requestAccounts = async () => ({ items: [account("a-1")] });
    await selectSite(wrapper, "site-a");
    await flushPromises();
    expect(selectedAccount(wrapper)).toBe("a-1");
    expect(browser(wrapper, "a-1").props("active")).toBe(true);
    expect(browser(wrapper, "a-2")).toBeUndefined();
  });

  it("uses a deep-linked account initially and remembers subsequent manual choices", async () => {
    const wrapper = await mountEnvironment({ webEntryId: "site-a", webCredentialId: "a-2" });
    expect(selectedAccount(wrapper)).toBe("a-2");
    await selectAccount(wrapper, "a-1");
    await selectSite(wrapper, "site-b");
    await flushPromises();
    await selectSite(wrapper, "site-a");
    await flushPromises();
    expect(selectedAccount(wrapper)).toBe("a-1");
  });

  it("honors an explicit immersive account choice and remembers it on later website switches", async () => {
    const wrapper = await mountEnvironment({ immersive: "1" });
    await selectSite(wrapper, "site-b");
    await flushPromises();
    const refresh = deferred<AccountResponse>();
    requestAccounts = (entryId) => entryId === "site-a" ? refresh.promise : Promise.resolve({ items: accounts[entryId] });
    wrapper.findComponent({ name: "EnvironmentImmersiveNavigation" }).vm.$emit("selectCredential", "site-a", "a-2");
    await vi.waitFor(() => expect(selectedAccount(wrapper)).toBe("a-2"));
    expect(browser(wrapper, "a-2").props("active")).toBe(true);
    refresh.resolve({ items: accounts["site-a"] });
    await flushPromises();
    await selectSite(wrapper, "site-b");
    await flushPromises();
    await selectSite(wrapper, "site-a");
    expect(selectedAccount(wrapper)).toBe("a-2");
  });

  it("retains the restored page if its background account refresh fails", async () => {
    const error = vi.spyOn(ElMessage, "error").mockImplementation(() => ({ close() {} }));
    const wrapper = await mountEnvironment();
    await selectAccount(wrapper, "a-2");
    await selectSite(wrapper, "site-b");
    await flushPromises();
    requestAccounts = async () => { throw new Error("refresh failed"); };
    await selectSite(wrapper, "site-a");
    await flushPromises();
    expect(selectedAccount(wrapper)).toBe("a-2");
    expect(browser(wrapper, "a-2").props("active")).toBe(true);
    expect(wrapper.find(".web-view-pane__empty").exists()).toBe(false);
    expect(error).toHaveBeenCalledWith("refresh failed");
  });
});
