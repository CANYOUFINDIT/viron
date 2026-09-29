/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import EnvironmentImmersiveNavigation from "../src/client/components/EnvironmentImmersiveNavigation.vue";
import { i18nPlugin } from "../src/client/i18n";
import type { ImmersiveWorkspaceTab } from "../src/shared/immersive-navigation";

vi.mock("../src/client/desktop", () => ({
  onDesktopImmersiveNavigationAction: () => () => undefined,
  updateDesktopImmersiveNavigation: vi.fn(async () => undefined),
}));

const counts: Record<ImmersiveWorkspaceTab, number> = {
  web: 1,
  ssh: 0,
  logs: 0,
  database: 0,
  redis: 0,
  knowledge: 0,
  maintenance: 0,
};

function mountNavigation() {
  return mount(EnvironmentImmersiveNavigation, {
    props: {
      native: false,
      environmentName: "demo",
      activeTab: "web",
      selectedEntryId: "entry-1",
      selectedCredentialId: "cred-1",
      counts,
      maintenanceHostCount: 0,
      entries: [],
    },
    attachTo: document.body,
    global: { plugins: [i18nPlugin] },
  });
}

describe("immersive navigation click to expand", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("keeps the web edge handle collapsed on hover and opens it on click", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const wrapper = mountNavigation();
    const handle = document.querySelector<HTMLButtonElement>(".immersive-edge-handle");
    expect(handle).not.toBeNull();
    handle!.setPointerCapture = () => undefined;
    handle!.releasePointerCapture = () => undefined;

    handle!.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelector(".immersive-navigation-panel")).toBeNull();

    handle!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1, clientX: 20, clientY: 20, bubbles: true }));
    handle!.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerId: 1, clientX: 20, clientY: 20, bubbles: true }));
    await flushPromises();
    expect(document.querySelector(".immersive-navigation-panel")).not.toBeNull();

    document.querySelector(".environment-immersive-navigation")!.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", bubbles: true }));
    await vi.advanceTimersByTimeAsync(79);
    expect(document.querySelector(".immersive-navigation-panel")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".immersive-navigation-panel")).toBeNull();
    wrapper.unmount();
  });

  it("keeps the desktop edge handle collapsed on hover and toggles it on click", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const html = readFileSync(resolve("public/desktop-immersive-navigation.html"), "utf8");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    document.body.innerHTML = `<main id="app"></main>`;
    const actions: Array<{ type: string }> = [];
    let publish: ((state: unknown) => void) | null = null;
    Object.defineProperty(window, "vironImmersiveNavigation", {
      configurable: true,
      value: {
        action: (action: { type: string }) => { actions.push(action); },
        onState: (listener: (state: unknown) => void) => { publish = listener; },
      },
    });
    window.eval(script!);
    publish?.({
      language: "zh-CN",
      expanded: false,
      dark: false,
      dock: { edge: "right", offset: 0.5 },
    });

    const handle = document.querySelector<HTMLButtonElement>(".handle");
    expect(handle?.getAttribute("aria-label")).toBe("展开环境导航");
    handle!.setPointerCapture = () => undefined;
    handle!.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(actions).toEqual([]);

    handle!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 1, screenX: 40, screenY: 40, bubbles: true }));
    handle!.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerId: 1, screenX: 40, screenY: 40, bubbles: true }));
    expect(actions).toEqual([{ type: "toggle" }]);
  });
});
