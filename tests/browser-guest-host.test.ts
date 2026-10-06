// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserHostMessage } from "../src/shared/browser-host";

describe("browser guest presentation", () => {
  let receive: (message: BrowserHostMessage) => void;
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
    Object.defineProperty(window, "vironDesktop", { configurable: true, value: {
      onBrowserHostMessage: (callback: typeof receive) => { receive = callback; },
      attachBrowserGuest: vi.fn().mockResolvedValue(undefined),
    } });
  });
  async function setup() {
    const host = await import("../src/client/browser-guest-host");
    host.installBrowserGuestHost();
    const surface = document.createElement("div");
    document.body.appendChild(surface);
    surface.getBoundingClientRect = () => new DOMRect(100, 120, 420, 270);
    const visible = { value: true };
    const remove = host.registerBrowserSurface("view", () => surface, () => visible.value);
    receive({ type: "create", request: { token: "guest", viewId: "view", pageId: "page", partition: "persist:test-account", width: 420, height: 270 } });
    const guest = document.querySelector("webview")! as HTMLElement;
    return { host, guest, visible, remove };
  }
  function present(revision: number, visible = true, focus = false) {
    receive({ type: "present", presentation: { token: "guest", revision, visible, focus, bounds: { x: 100, y: 120, width: 420, height: 270 } } });
  }
  it("preserves the guest when its surface is hidden, replaced, and restored", async () => {
    const { host, guest, visible, remove } = await setup();
    present(1);
    expect(guest.style.visibility).toBe("visible");
    visible.value = false; host.updateBrowserGuestLayout();
    expect(guest.style.pointerEvents).toBe("none");
    expect(guest.isConnected).toBe(true);
    remove();
    const replacement = document.createElement("div"); document.body.appendChild(replacement);
    replacement.getBoundingClientRect = () => new DOMRect(200, 150, 500, 300);
    host.registerBrowserSurface("view", () => replacement, () => true);
    expect(document.querySelector("webview")).toBe(guest);
    expect(guest.ownerDocument).toBe(document);
    expect(guest.style.left).toBe("200px");
    expect(guest.style.visibility).toBe("visible");
  });
  it("rejects old presentation updates and consumes focus only once", async () => {
    const { host, guest } = await setup();
    const focus = vi.spyOn(guest, "focus");
    present(4, true, true);
    expect(focus).toHaveBeenCalledTimes(1);
    host.updateBrowserGuestLayout();
    expect(focus).toHaveBeenCalledTimes(1);
    present(3, false);
    expect(guest.style.visibility).toBe("visible");
    present(5, false);
    expect(guest.style.pointerEvents).toBe("none");
  });
  it("uses the assigned profile and does not enable privileged renderer attributes", async () => {
    const { guest } = await setup();
    expect(guest.getAttribute("partition")).toBe("persist:test-account");
    expect(guest.hasAttribute("nodeintegration")).toBe(false);
    expect(guest.hasAttribute("preload")).toBe(false);
    receive({ type: "destroy", token: "guest" });
    present(2);
    expect(guest.isConnected).toBe(false);
    expect(document.querySelector("webview")).toBeNull();
  });
  it("clips to a scrolling container without resizing or remounting the page", async () => {
    const { host, guest } = await setup();
    const surface = document.body.firstElementChild!;
    const container = document.createElement("div");
    container.style.overflowX = "hidden";
    container.style.overflowY = "hidden";
    container.getBoundingClientRect = () => new DOMRect(120, 130, 200, 100);
    Object.defineProperties(container, { clientWidth: { value: 200 }, clientHeight: { value: 100 } });
    document.body.appendChild(container); container.appendChild(surface);
    present(1);
    expect(guest.style.width).toBe("420px");
    expect(guest.style.clipPath).toBe("inset(10px 200px 160px 20px)");
    container.getBoundingClientRect = () => new DOMRect(600, 130, 200, 100);
    host.updateBrowserGuestLayout();
    expect(guest.style.pointerEvents).toBe("none");
    expect(guest.isConnected).toBe(true);
  });
});
