/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { useDatabaseLayout } from "../src/client/components/database-workbench/use-database-layout";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("database navigation pane resize", () => {
  it("resizes the workbench grid during drag and persists the final width", () => {
    let paint: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      paint = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const preferences = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => preferences.get(key) ?? null,
      setItem: (key: string, value: string) => preferences.set(key, value),
    });

    const scope = effectScope();
    const layout = scope.run(() => useDatabaseLayout({ workspaceKey: "resize-test", active: true }))!;
    const workbench = document.createElement("section");
    workbench.getBoundingClientRect = () => ({ left: 100, right: 1100, width: 1000 } as DOMRect);
    layout.workbenchElement.value = workbench;
    const divider = document.createElement("button");
    divider.append(document.createElement("span"));
    divider.addEventListener("pointerdown", layout.startConnectionPaneResize);
    document.body.append(divider);

    divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX: 340 }));
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 460 }));
    paint?.(0);

    expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("360px");
    expect(layout.connectionPaneWidth.value).toBe(240);
    expect(layout.workbenchStyle.value["--connection-pane-width"]).toBe("240px");

    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 460 }));

    expect(layout.connectionPaneWidth.value).toBe(360);
    expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("360px");
    expect(JSON.parse(preferences.get("envman:database-workbench:resize-test:global")!)).toMatchObject({ connectionPaneWidth: 360 });

    divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, isPrimary: true, button: 0, clientX: 460 }));
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 260 }));
    paint?.(0);
    expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("160px");
    expect(layout.connectionPaneVisible.value).toBe(true);

    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 210 }));
    expect(layout.connectionPaneVisible.value).toBe(false);
    expect(layout.connectionPaneWidth.value).toBe(360);
    expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("360px");

    layout.setConnectionPaneVisible(true);
    expect(layout.connectionPaneVisible.value).toBe(true);
    expect(layout.connectionPaneWidth.value).toBe(360);
    scope.stop();
  });
});
