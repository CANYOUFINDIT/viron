export const WORKBENCH_RESIZE_END_EVENT = "viron:workbench-resize-end";

export function observeTableGridResize(element: HTMLElement, table: { redraw(force?: boolean): void }): () => void {
  const workbench = element.closest(".database-workbench");
  let width = 0;
  let height = 0;
  let dirty = false;
  let frame = 0;
  const schedule = () => {
    if (!dirty || frame || width <= 0 || height <= 0 || element.closest("[data-workbench-resizing]")) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!dirty || width <= 0 || height <= 0 || element.closest("[data-workbench-resizing]")) return;
      dirty = false;
      table.redraw(true);
    });
  };
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const nextWidth = Math.floor(entry.contentRect.width);
    const nextHeight = Math.floor(entry.contentRect.height);
    if (width === nextWidth && height === nextHeight) return;
    width = nextWidth;
    height = nextHeight;
    dirty = true;
    // fitData columns keep their widths as the viewport changes. Let CSS resize
    // the viewport during a drag, then measure and redraw the columns once.
    schedule();
  });
  observer.observe(element);
  workbench?.addEventListener(WORKBENCH_RESIZE_END_EVENT, schedule);
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    workbench?.removeEventListener(WORKBENCH_RESIZE_END_EVENT, schedule);
  };
}
