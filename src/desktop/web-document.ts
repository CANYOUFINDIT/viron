import type { WebContents } from "electron";

const loading = new WeakMap<WebContents, boolean>();

/** Track document readiness separately from late images and other subresources. */
export function webDocumentLoading(contents: WebContents): boolean {
  if (!loading.has(contents)) {
    loading.set(contents, contents.isLoadingMainFrame());
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) loading.set(contents, true); });
    contents.on("dom-ready", () => loading.set(contents, false));
    contents.on("did-stop-loading", () => loading.set(contents, false));
  }
  return loading.get(contents)!;
}

export function loadWebDocument(contents: WebContents, url: string): Promise<void> {
  webDocumentLoading(contents);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); contents.off("dom-ready", ready); contents.off("destroyed", destroyed); };
    const ready = () => { cleanup(); resolve(); };
    const destroyed = () => { cleanup(); reject(new Error("document-destroyed")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("document-loading-timeout")); }, 30_000);
    timer.unref();
    contents.once("dom-ready", ready); contents.once("destroyed", destroyed);
    // Consume late full-load failures when form submission replaces the document.
    void contents.loadURL(url).then(ready, (error) => { cleanup(); reject(error); });
  });
}

/** Electron's executeJavaScript waits for full load, including unrelated images. */
export async function evaluateWebIsolated<T>(contents: WebContents, expression: string, worldName: string): Promise<T> {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  const tree = await contents.debugger.sendCommand("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
  const world = await contents.debugger.sendCommand("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName }) as { executionContextId: number };
  const result = await contents.debugger.sendCommand("Runtime.evaluate", {
    expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true, userGesture: true,
  }) as { result: { value?: T }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error("runtime-error");
  return result.result.value as T;
}
