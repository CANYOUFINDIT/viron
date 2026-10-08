// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock("../src/client/service-socket", () => ({ ServiceSocket: class extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  constructor() { super(); fixture.sockets.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
} }));
const view = { protectedLogin: null, loginMode: "protected", loginNotice: "", loading: false, activePageId: "page", pages: [],
  credentialId: "credential", entryId: "entry", entryName: "Fixture", entryUrl: "https://console.example.test/login", url: "https://console.example.test/login", username: "fixture-user", title: "Fixture", viewport: { width: 900, height: 650 } };
vi.mock("../src/client/api", () => ({ api: vi.fn(), transientApi: vi.fn(async () => ({ view, frame: "fixture-frame", ticket: "fixture-ticket" })) }));
vi.mock("../src/client/active-connections", () => ({ loadActiveConnections: vi.fn(async () => {}) }));
vi.mock("../src/client/desktop", () => ({ isDesktopApp: () => false, downloadApiFile: vi.fn() }));
vi.mock("../src/client/history-navigation", () => ({ applyHistoryNavigationCommand: vi.fn(), applyHistoryNavigationWheel: () => ({ status: "idle" }) }));
import WebAccountBrowser from "../src/client/components/WebAccountBrowser.vue";

afterEach(() => { fixture.sockets.length = 0; });
async function setup() {
  const wrapper = mount(WebAccountBrowser, { props: { credentialId: "credential", entryId: "entry", entryName: "Fixture", username: "fixture-user", entryUrl: view.entryUrl,
    externalHref: view.entryUrl, active: true, autoConnect: true }, global: { mocks: { $t: (key: string) => key }, stubs: { TlsPopover: true, WebPageTabStrip: true, WebPageLoadProgress: true } } });
  await flushPromises();
  const socket = fixture.sockets[0];
  expect(socket).toBeTruthy();
  const message = async (payload: unknown) => { socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); await flushPromises(); };
  return { wrapper, socket, message };
}
describe("Web account context-menu filling", () => {
  it("shows the normal page and sends only the selected fill action from its context menu", async () => {
    const { wrapper, socket, message } = await setup();
    try {
      expect(wrapper.find(".web-browser-surface > img").exists()).toBe(true);
      expect(wrapper.find(".protected-web-login").exists()).toBe(false);
      expect(wrapper.find(".web-login-notice").exists()).toBe(false);
      const surface = wrapper.get(".web-browser-surface");
      await surface.trigger("mousedown", { button: 2 }); await surface.trigger("mouseup", { button: 2 });
      await surface.trigger("contextmenu", { clientX: 50, clientY: 70, button: 2 });
      const request = socket.sent.at(-1);
      expect(request).toMatchObject({ type: "credential-context", pageId: "page", x: 0, y: 0 });
      expect(socket.sent.some((item: any) => item.type === "mouse")).toBe(false);
      await message({ type: "credential-context", requestId: request.requestId, pageId: "page", token: "selected-input" });
      expect(wrapper.get('[role="menu"]').text()).toBe("填入用户名填入密码");
      await wrapper.get('[role="menuitem"]:last-child').trigger("click");
      expect(socket.sent.at(-1)).toEqual({ type: "fill-password", pageId: "page", token: "selected-input" });
      expect(wrapper.find('[role="menu"]').exists()).toBe(false);
      await wrapper.get('button[aria-label="填充用户名和密码"]').trigger("click");
      expect(socket.sent.at(-1)).toEqual({ type: "refill" });
    } finally { wrapper.unmount(); }
  });
  it("ignores a delayed menu reply after navigation", async () => {
    const { wrapper, socket, message } = await setup();
    try {
      await wrapper.get(".web-browser-surface").trigger("contextmenu", { clientX: 50, clientY: 70 });
      const request = socket.sent.at(-1);
      await message({ type: "state", view: { ...view, url: "https://console.example.test/settings" } });
      await message({ type: "credential-context", requestId: request.requestId, pageId: "page", token: "stale-input" });
      expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    } finally { wrapper.unmount(); }
  });
});
