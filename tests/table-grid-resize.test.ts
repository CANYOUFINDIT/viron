/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeTableGridResize, WORKBENCH_RESIZE_END_EVENT } from "../src/client/table-grid-resize";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("database grid viewport resize", () => {
  it("defers expensive column measurement during drag and redraws once on release", () => {
    let notify: ResizeObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { notify = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const workbench = document.createElement("section");
    workbench.className = "database-workbench";
    const grid = document.createElement("div");
    workbench.append(grid);
    document.body.append(workbench);
    const table = { redraw: vi.fn() };
    const stop = observeTableGridResize(grid, table);
    const resize = (width: number, height = 400) => notify([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);

    workbench.setAttribute("data-workbench-resizing", "");
    for (let width = 800; width > 600; width -= 4) resize(width);
    expect(frames.size).toBe(0);
    expect(table.redraw).not.toHaveBeenCalled();
    workbench.removeAttribute("data-workbench-resizing");
    workbench.dispatchEvent(new Event(WORKBENCH_RESIZE_END_EVENT));
    expect(frames.size).toBe(1);
    const [id, paint] = [...frames][0];
    frames.delete(id);
    paint(0);
    expect(table.redraw).toHaveBeenCalledOnce();

    resize(604);
    expect(frames.size).toBe(0);
    resize(0, 0);
    workbench.dispatchEvent(new Event(WORKBENCH_RESIZE_END_EVENT));
    expect(frames.size).toBe(0);
    resize(604);
    expect(frames.size).toBe(1);
    stop();
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
    workbench.dispatchEvent(new Event(WORKBENCH_RESIZE_END_EVENT));
    expect(frames.size).toBe(0);
  });
});
