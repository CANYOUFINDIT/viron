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

    expect(workbench.style.gridTemplateColumns).toBe("360px minmax(0, 1fr)");
    expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("");
    expect(layout.connectionPaneWidth.value).toBe(240);
    expect(layout.workbenchStyle.value["--connection-pane-width"]).toBe("240px");

    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 460 }));

    expect(layout.connectionPaneWidth.value).toBe(360);
    expect(workbench.style.gridTemplateColumns).toBe("");
    expect(workbench.style.getPropertyValue("--connection-pane-width")).toBe("360px");
    expect(JSON.parse(preferences.get("envman:database-workbench:resize-test:global")!)).toMatchObject({ connectionPaneWidth: 360 });

    divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, isPrimary: true, button: 0, clientX: 460 }));
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 260 }));
    paint?.(0);
    expect(workbench.style.gridTemplateColumns).toBe("160px minmax(0, 1fr)");
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

  it("previews the information pane without reactive updates and cleans up a cancelled drag", () => {
    let paint: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { paint = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const persist = vi.fn();
    vi.stubGlobal("localStorage", { setItem: persist });
    const scope = effectScope();
    const layout = scope.run(() => useDatabaseLayout({ workspaceKey: "resize-test", active: true }))!;
    const workbench = document.createElement("section");
    workbench.getBoundingClientRect = () => ({ left: 100, right: 1300, width: 1200 } as DOMRect);
    layout.workbenchElement.value = workbench;
    layout.informationPaneVisible.value = true;
    const divider = document.createElement("button");
    divider.addEventListener("pointerdown", layout.startExplorerPaneResize);
    document.body.append(divider);
    divider.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0 }));
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 940 }));
    expect(paint).toBeUndefined();
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 940 }));
    paint?.(0);
    expect(workbench.style.gridTemplateColumns).toBe("240px minmax(0, 1fr) 360px");
    expect(layout.explorerPaneWidth.value).toBe(280);
    expect(persist).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("blur"));
    expect(workbench.style.gridTemplateColumns).toBe("");
    expect(workbench.hasAttribute("data-workbench-resizing")).toBe(false);
    expect(layout.explorerPaneWidth.value).toBe(280);

    divider.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, isPrimary: true, button: 0 }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, clientX: 980 }));
    expect(layout.explorerPaneWidth.value).toBe(320);
    expect(persist).toHaveBeenCalledOnce();
    scope.stop();
  });
});
