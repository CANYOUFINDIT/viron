import { basename } from "node:path";
import { translate as tr } from "../i18n.js";
import {
  activeDesktopWebPage,
  closeDesktopWebView,
  handleDesktopWebViewAction,
  inspectDesktopWebElement,
  localWebView,
  openDesktopWebView,
  resetDesktopWebView,
  type ManagedDesktopWebView,
} from "../web-view-runtime.js";

export async function waitForDesktopWebTitle(view: ManagedDesktopWebView, expected: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = activeDesktopWebPage(view).view.webContents.getTitle();
    if (title === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(tr("等待本机页面标题超时：{{0}}", [expected]));
}

export async function waitForDesktopWebNotice(view: ManagedDesktopWebView, type: "success" | "error", timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (view.notice?.type === type) return;
    if (view.notice?.type === "error") throw new Error(view.notice.message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(tr("等待本机网页下载完成超时"));
}

export async function runDesktopWebSmoke(credentialId: string, username: string, uploadPath?: string): Promise<{
  opened: boolean;
  blankOpenedWithoutEntry: boolean;
  manualRefillOnCurrentPage: boolean;
  sessionStatePersisted: boolean;
  lastLocationRestored: boolean;
  tabsReordered: boolean;
  inspectorOpened: boolean;
  resetCleared: boolean;
  uploadSelected: boolean | null;
  downloadTriggered: boolean;
}> {
  const blankState = await openDesktopWebView(credentialId, { x: 40, y: 120, width: 900, height: 620 }, "blank");
  const blankView = localWebView(blankState.id);
  const deferredEntryPage = blankView.pages.get(blankState.pages[0]?.id ?? "");
  const blankOpenedWithoutEntry = blankState.pages.length === 2
    && blankState.pages[0]?.url === blankView.entryUrl
    && blankState.pages[1]?.url === "about:blank"
    && blankState.activePageId === blankState.pages[1]?.id
    && blankState.url === "about:blank"
    && deferredEntryPage?.pendingUrl === blankView.entryUrl
    && deferredEntryPage.view.webContents.getURL() === "";
  const blankTarget = new URL(blankView.entryUrl);
  await handleDesktopWebViewAction(blankState.id, { type: "navigate", url: `${blankTarget.host}/upload` });
  await waitForDesktopWebTitle(blankView, "Upload fixture");
  const shorthandAddressLoaded = activeDesktopWebPage(blankView).view.webContents.getURL() === `${blankView.entryOrigin}/upload`;
  const reorderedBlankState = await handleDesktopWebViewAction(blankState.id, {
    type: "reorder-pages",
    orderedPageIds: blankState.pages.map((page) => page.id).reverse(),
  });
  const tabsReordered = reorderedBlankState.pages[0]?.id === blankState.pages[1]?.id
    && reorderedBlankState.pages[1]?.id === blankState.pages[0]?.id;
  const activatedEntryState = await handleDesktopWebViewAction(blankState.id, { type: "activate-page", pageId: blankState.pages[0]?.id });
  const defaultAddressPreserved = activatedEntryState.activePageId === blankState.pages[0]?.id
    && activatedEntryState.url === blankView.entryUrl;
  await handleDesktopWebViewAction(blankState.id, { type: "activate-page", pageId: blankState.pages[1]?.id });
  await handleDesktopWebViewAction(blankState.id, { type: "navigate", url: `${blankTarget.host}/` });
  await waitForDesktopWebTitle(blankView, "Login");
  await handleDesktopWebViewAction(blankState.id, { type: "refill" });
  await waitForDesktopWebTitle(blankView, `Logged ${username}`);
  const manualRefillOnCurrentPage = activeDesktopWebPage(blankView).view.webContents.getTitle() === `Logged ${username}`;
  await activeDesktopWebPage(blankView).view.webContents.executeJavaScript(`localStorage.setItem("viron-persist-smoke", "present")`);
  await activeDesktopWebPage(blankView).view.webContents.loadURL(`${blankView.entryOrigin}/upload`);
  await waitForDesktopWebTitle(blankView, "Upload fixture");
  await closeDesktopWebView(blankState.id);
  const managedState = await openDesktopWebView(credentialId, { x: 40, y: 120, width: 900, height: 620 });
  const managed = localWebView(managedState.id);
  await waitForDesktopWebTitle(managed, "Upload fixture");
  const lastLocationRestored = activeDesktopWebPage(managed).view.webContents.getURL() === `${managed.entryOrigin}/upload`;
  const sessionStatePersisted = await activeDesktopWebPage(managed).view.webContents.executeJavaScript(`localStorage.getItem("viron-persist-smoke") === "present"`) as boolean;
  const initialPage = activeDesktopWebPage(managed).view.webContents;
  const devToolsOpened = initialPage.isDevToolsOpened()
    ? Promise.resolve()
    : new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error(tr("等待网页检查器打开超时"))), 10_000);
      initialPage.once("devtools-opened", () => {
        clearTimeout(timeout);
        resolveOpen();
      });
    });
  inspectDesktopWebElement(initialPage, 8, 8);
  await devToolsOpened;
  initialPage.closeDevTools();
  await initialPage.executeJavaScript(`localStorage.setItem("viron-reset-smoke", "present")`);
  await resetDesktopWebView(managed);
  await waitForDesktopWebTitle(managed, `Logged ${username}`);
  const resetCleared = await activeDesktopWebPage(managed).view.webContents.executeJavaScript(`localStorage.getItem("viron-reset-smoke") === null`) as boolean;

  let uploadSelected: boolean | null = null;
  if (uploadPath) {
    const uploadPage = activeDesktopWebPage(managed).view.webContents;
    await uploadPage.loadURL(`${managed.entryOrigin}/upload`);
    await waitForDesktopWebTitle(managed, "Upload fixture");
    uploadPage.debugger.attach("1.3");
    try {
      const document = await uploadPage.debugger.sendCommand("DOM.getDocument") as { root: { nodeId: number } };
      const input = await uploadPage.debugger.sendCommand("DOM.querySelector", { nodeId: document.root.nodeId, selector: "input[type=file]" }) as { nodeId: number };
      await uploadPage.debugger.sendCommand("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [uploadPath] });
    } finally {
      uploadPage.debugger.detach();
    }
    await waitForDesktopWebTitle(managed, `Selected ${basename(uploadPath)}`);
    uploadSelected = true;
  }

  const downloadPage = activeDesktopWebPage(managed).view.webContents;
  await downloadPage.loadURL(`${managed.entryOrigin}/download`);
  await waitForDesktopWebTitle(managed, "Download fixture");
  managed.notice = null;
  await downloadPage.executeJavaScript(`document.querySelector("a[download]").click()`);
  await waitForDesktopWebNotice(managed, "success");
  return { opened: true, blankOpenedWithoutEntry: blankOpenedWithoutEntry && shorthandAddressLoaded && defaultAddressPreserved, manualRefillOnCurrentPage, sessionStatePersisted, lastLocationRestored, tabsReordered, inspectorOpened: true, resetCleared, uploadSelected, downloadTriggered: true };
}


