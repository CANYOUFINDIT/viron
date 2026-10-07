import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { app, BrowserWindow } from "electron";
import { readState } from "../app-state.js";
import { translate as tr } from "../i18n.js";
import { mainWindow } from "../window-host.js";
import { closeDesktopWebExtensionPopup, desktopWebExtensionPopupContents, enableDesktopChromeWebStore, forgetDesktopWebExtensions, importDesktopChromeExtension, listDesktopWebExtensions, loadDesktopWebExtensions, openDesktopWebExtensionPopup, removeDesktopWebExtension, scanDesktopChromeExtensions, updateDesktopWebExtension } from "../web-extensions.js";
import { desktopWebExtensionContextMenuItems } from "../web-extension-context-menus.js";
import {
  activeDesktopWebPage,
  closeDesktopWebView,
  handleDesktopWebViewAction,
  inspectDesktopWebElement,
  localWebView,
  openDesktopWebView,
  resetDesktopWebView,
  webViewState,
  type ManagedDesktopWebView,
} from "../web-view-runtime.js";

export async function waitForDesktopWebTitle(view: ManagedDesktopWebView, expected: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (view.login?.state.phase === "failed") throw new Error(view.login.state.message);
    const title = view.login ? "" : activeDesktopWebPage(view).view.webContents.getTitle();
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

async function extensionMarkerLoaded(view: ManagedDesktopWebView): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await activeDesktopWebPage(view).view.webContents.executeJavaScript('document.documentElement.dataset.vironExtension === "loaded"') as boolean) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function runDesktopWebSmoke(credentialId: string, username: string, uploadPath?: string, chromeExtensionId?: string): Promise<{
  opened: boolean;
  blankOpenedWithoutEntry: boolean;
  manualRefillOnCurrentPage: boolean;
  sessionStatePersisted: boolean;
  extensionProfilePersisted: boolean;
  lastLocationRestored: boolean;
  tabsReordered: boolean;
  popupPreservesOpener: boolean;
  inspectorOpened: boolean;
  resetCleared: boolean;
  extensionInjected: boolean;
  extensionManaged: boolean | null;
  extensionGlobal: boolean | null;
  uploadSelected: boolean | null;
  downloadTriggered: boolean;
}> {
  const blankState = await openDesktopWebView(credentialId, { x: 40, y: 120, width: 900, height: 620 }, "blank");
  const blankView = localWebView(blankState.id);
  const extensionLoaded = listDesktopWebExtensions(blankView.partition, blankView.lastUrlKey).some((item) => item.loaded);
  const deferredEntryPage = blankView.pages.get(blankState.pages[0]?.id ?? "");
  const blankOpenedWithoutEntry = blankState.pages.length === 2
    && blankState.pages[0]?.url === blankView.entryUrl
    && blankState.pages[1]?.url === "about:blank"
    && blankState.activePageId === blankState.pages[1]?.id
    && blankState.url === "about:blank"
    && deferredEntryPage?.pendingUrl === blankView.entryUrl
    && deferredEntryPage.view.webContents.getURL() === "about:blank";
  const blankTarget = new URL(blankView.entryUrl);
  await handleDesktopWebViewAction(blankState.id, { type: "navigate", url: `${blankTarget.host}/upload` });
  await waitForDesktopWebTitle(blankView, "Upload fixture");
  const extensionOnFirstPage = await extensionMarkerLoaded(blankView);
  const shorthandAddressLoaded = activeDesktopWebPage(blankView).view.webContents.getURL() === `${blankView.entryOrigin}/upload`;
  const reorderedBlankState = await handleDesktopWebViewAction(blankState.id, {
    type: "reorder-pages",
    orderedPageIds: blankState.pages.map((page) => page.id).reverse(),
  });
  const tabsReordered = reorderedBlankState.pages[0]?.id === blankState.pages[1]?.id
    && reorderedBlankState.pages[1]?.id === blankState.pages[0]?.id;
  await handleDesktopWebViewAction(blankState.id, { type: "activate-page", pageId: blankState.pages[0]?.id });
  await waitForDesktopWebTitle(blankView, `Logged ${username}`);
  const defaultAddressPreserved = webViewState(blankView).url === blankView.entryUrl;
  // Deferred entries now use protected login too. Simulate an expired website
  // session before checking the separate manual background-login action.
  await blankView.partition.cookies.remove(blankView.entryOrigin, "account");
  await handleDesktopWebViewAction(blankState.id, { type: "navigate", url: `${blankTarget.host}/` });
  await waitForDesktopWebTitle(blankView, "Login");
  await handleDesktopWebViewAction(blankState.id, { type: "refill" });
  await waitForDesktopWebTitle(blankView, `Logged ${username}`);
  const manualRefillOnCurrentPage = activeDesktopWebPage(blankView).view.webContents.getTitle() === `Logged ${username}`;
  const installCount = () => activeDesktopWebPage(blankView).view.webContents.executeJavaScript('Number(document.documentElement.dataset.vironInstallCount || 0)');
  let firstInstallCount = 0;
  for (let attempt = 0; attempt < 40 && firstInstallCount !== 1; attempt++) {
    firstInstallCount = await installCount() as number;
    if (firstInstallCount !== 1) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await activeDesktopWebPage(blankView).view.webContents.executeJavaScript(`localStorage.setItem("viron-persist-smoke", "present")`);
  await activeDesktopWebPage(blankView).view.webContents.loadURL(`${blankView.entryOrigin}/upload`);
  await waitForDesktopWebTitle(blankView, "Upload fixture");
  await closeDesktopWebView(blankState.id);
  const openingState = await openDesktopWebView(credentialId, { x: 40, y: 120, width: 900, height: 620 });
  const managed = localWebView(openingState.id);
  await waitForDesktopWebTitle(managed, "Upload fixture");
  const managedState = webViewState(managed);
  await enableDesktopChromeWebStore(managed);
  const lastLocationRestored = activeDesktopWebPage(managed).view.webContents.getURL() === `${managed.entryOrigin}/upload`;
  const sessionStatePersisted = managed.partitionName === blankView.partitionName
    && await activeDesktopWebPage(managed).view.webContents.executeJavaScript(`localStorage.getItem("viron-persist-smoke") === "present" && document.cookie.includes("account=")`) as boolean;
  const extensionInstallCountAfterReopen = await activeDesktopWebPage(managed).view.webContents.executeJavaScript('Number(document.documentElement.dataset.vironInstallCount || 0)') as number;
  const popupDocumentPreserved = await activeDesktopWebPage(managed).view.webContents.executeJavaScript(`(() => {
    const child = window.open("about:blank", "viron-popup-smoke");
    if (!child) return false;
    child.document.write("<title>Popup fixture</title><p id='result'>Original popup document</p>");
    child.document.close();
    const preserved = child.opener === window && child.document.getElementById("result").textContent === "Original popup document";
    window.__vironSmokePopup = child;
    return preserved;
  })()`, true) as boolean;
  const popupPage = [...managed.pages.values()].find((page) => page.view.kind === "window");
  const reorderedWithPopup = await handleDesktopWebViewAction(managed.id, {
    type: "reorder-pages", orderedPageIds: managedState.pages.map((page) => page.id),
  });
  const popupPreservesOpener = popupDocumentPreserved && popupPage?.view.webContents.session === managed.partition
    && reorderedWithPopup.pages.length === managedState.pages.length;
  await activeDesktopWebPage(managed).view.webContents.executeJavaScript("window.__vironSmokePopup?.close();delete window.__vironSmokePopup");
  const extensionAfterReopen = await extensionMarkerLoaded(managed);
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
  const extensionAfterReset = await extensionMarkerLoaded(managed);
  const extensionProfilePersisted = firstInstallCount === 1 && extensionInstallCountAfterReopen === 1
    && await activeDesktopWebPage(managed).view.webContents.executeJavaScript('Number(document.documentElement.dataset.vironInstallCount || 0) === 1 && document.documentElement.dataset.vironCredentialObserved !== "yes"') as boolean;

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
  let extensionManaged: boolean | null = null;
  let extensionGlobal: boolean | null = null;
  if (chromeExtensionId) {
    const secondCredentialId = process.env.VIRON_DESKTOP_SMOKE_SECOND_WEB_CREDENTIAL_ID;
    const second = secondCredentialId ? localWebView((await openDesktopWebView(secondCredentialId, managed.bounds, "blank", false)).id) : null;
    const legacyShared = second ? listDesktopWebExtensions(second.partition, second.lastUrlKey).some((item) => item.loaded) : false;
    const before = listDesktopWebExtensions(managed.partition, managed.lastUrlKey);
    const scanned = (await scanDesktopChromeExtensions()).find((item) => item.chromeId === chromeExtensionId);
    if (!scanned) throw new Error("Chrome extension was not found");
    const installed = await importDesktopChromeExtension(managed.partition, managed.lastUrlKey, scanned.token);
    const added = installed.find((item) => !before.some((existing) => existing.installId === item.installId));
    if (!added) throw new Error("Desktop extension was not installed");
    // Registration is asynchronous. Let onInstalled finish before exercising disable/re-enable.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (readState().webExtensionMenus?.[managed.lastUrlKey]?.[added.extensionId]?.some((item) => item.id === "fixture-menu")) break;
      if (attempt === 99) throw new Error("Extension menu initialization did not complete");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const secondExtension = () => second && listDesktopWebExtensions(second.partition, second.lastUrlKey).find((item) => item.installId === added.installId);
    const sharedInstall = secondExtension()?.loaded === true;
    let sharedContent = false;
    let isolatedSessions = false;
    if (second) {
      const page = activeDesktopWebPage(second).view.webContents;
      await page.loadURL(`${managed.entryOrigin}/upload`);
      sharedContent = await page.executeJavaScript('document.documentElement.dataset.vironInstalled === "loaded"') as boolean;
      await downloadPage.executeJavaScript('localStorage.setItem("global-extension-isolation", "first")');
      isolatedSessions = second.partition !== managed.partition && await page.executeJavaScript('localStorage.getItem("global-extension-isolation") === null') as boolean;
    }
    const pinned = (await updateDesktopWebExtension(managed.partition, managed.lastUrlKey, added.installId, { pinned: true }))
      .find((item) => item.installId === added.installId)?.pinned === true;
    const sharedPinned = secondExtension()?.pinned === true;
    const disabled = (await updateDesktopWebExtension(managed.partition, managed.lastUrlKey, added.installId, { enabled: false }))
      .find((item) => item.installId === added.installId)?.loaded === false;
    const sharedDisabled = secondExtension()?.enabled === false && secondExtension()?.loaded === false;
    const enabled = (await updateDesktopWebExtension(managed.partition, managed.lastUrlKey, added.installId, { enabled: true }))
      .find((item) => item.installId === added.installId)?.loaded === true;
    const sharedEnabled = secondExtension()?.loaded === true;
    const hasPopup = listDesktopWebExtensions(managed.partition, managed.lastUrlKey)
      .find((item) => item.installId === added.installId)?.hasPopup === true;
    await downloadPage.loadURL(downloadPage.getURL());
    await waitForDesktopWebTitle(managed, "Download fixture");
    const windowsBeforePopup = BrowserWindow.getAllWindows().length;
    const activeTabId = activeDesktopWebPage(managed).view.webContents.id;
    if (hasPopup) await openDesktopWebExtensionPopup(managed.partition, managed.lastUrlKey, added.installId, { right: 800, bottom: 100 }, activeTabId);
    const popupContents = desktopWebExtensionPopupContents(managed.lastUrlKey);
    const popupRendered = Boolean(popupContents && !popupContents.isDestroyed()
      && await popupContents.executeJavaScript('document.body?.textContent?.includes("Ready")')
      && BrowserWindow.getAllWindows().length === windowsBeforePopup + 1
      && BrowserWindow.fromWebContents(popupContents)?.getParentWindow() === mainWindow);
    const popupWindow = popupContents ? BrowserWindow.fromWebContents(popupContents) : null;
    const compactPopupSize = popupWindow?.getContentSize();
    const compactPopupFits = Boolean(compactPopupSize && Math.abs(compactPopupSize[0] - 320) <= 2 && Math.abs(compactPopupSize[1] - 260) <= 2);
    await popupContents?.executeJavaScript('document.querySelector("#resize")?.click()');
    let expandedPopupFits = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const size = popupWindow?.getContentSize();
      expandedPopupFits = Boolean(size && Math.abs(size[0] - 540) <= 2 && Math.abs(size[1] - 420) <= 2);
      if (expandedPopupFits) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const expandedPopupSize = popupWindow?.getContentSize();
    const popupTargetsWebPage = Boolean(await popupContents?.executeJavaScript(`chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs.length === 1 && tabs[0].id === ${activeTabId})`).catch(() => false));
    await popupContents?.executeJavaScript('document.querySelector("#translate")?.click()').catch(() => undefined);
    let translationApplied = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      translationApplied = await downloadPage.executeJavaScript('document.documentElement.dataset.vironTranslated === "yes"') as boolean;
      if (translationApplied) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mainWindow?.webContents.focus();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const popupClosedOnBlur = desktopWebExtensionPopupContents(managed.lastUrlKey) === null;
    let extensionMenuRendered = false;
    let extensionMenuCommand: (() => void) | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const menus = desktopWebExtensionContextMenuItems(managed.partition, downloadPage, {
        pageURL: downloadPage.getURL(), frameURL: downloadPage.getURL(), linkURL: "", srcURL: "", mediaType: "none", selectionText: "Selected fixture text", isEditable: false,
      });
      const command = menus.find((menu) => menu.label === "Fixture command");
      if (command) { extensionMenuRendered = true; extensionMenuCommand = command.click as (() => void) | undefined; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    closeDesktopWebExtensionPopup(managed.lastUrlKey);
    extensionMenuCommand?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (hasPopup) await openDesktopWebExtensionPopup(managed.partition, managed.lastUrlKey, added.installId, { right: 800, bottom: 100 }, activeTabId);
    const clickedContents = desktopWebExtensionPopupContents(managed.lastUrlKey);
    let extensionMenuClicked = false;
    for (let attempt = 0; attempt < 60 && clickedContents && !clickedContents.isDestroyed(); attempt += 1) {
      extensionMenuClicked = Boolean(await clickedContents.executeJavaScript('chrome.storage.local.get(["vironMenuClicked", "vironMenuCallbackError"]).then((value) => value.vironMenuClicked && value.vironMenuCallbackError)').catch(() => false))
        && await downloadPage.executeJavaScript('document.documentElement.dataset.vironMenuSelection === "Selected fixture text"') as boolean;
      if (extensionMenuClicked) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const menuPersisted = readState().webExtensionMenus?.[managed.lastUrlKey]?.[added.extensionId]?.some((item) => item.id === "fixture-menu") === true;
    await downloadPage.loadURL(`${managed.entryOrigin}/upload`);
    await waitForDesktopWebTitle(managed, "Upload fixture");
    const applied = await downloadPage.executeJavaScript('document.documentElement.dataset.vironInstalled === "loaded"') as boolean;
    await forgetDesktopWebExtensions(managed.partition, managed.lastUrlKey);
    const survivesAccountDeletion = secondExtension()?.loaded === true && readState().globalWebExtensions?.some((item) => item.installId === added.installId) === true;
    await loadDesktopWebExtensions(managed.partition, managed.lastUrlKey);
    const survivesReopen = listDesktopWebExtensions(managed.partition, managed.lastUrlKey).find((item) => item.installId === added.installId)?.loaded === true;
    await removeDesktopWebExtension(managed.partition, managed.lastUrlKey, added.installId);
    const sharedRemoved = !secondExtension() && !second?.partition.extensions.getExtension(added.extensionId);
    extensionGlobal = legacyShared && sharedInstall && sharedContent && isolatedSessions && sharedPinned && sharedDisabled && sharedEnabled && survivesAccountDeletion && survivesReopen && sharedRemoved;
    if (!extensionGlobal) console.log("VIRON_GLOBAL_EXTENSION_DIAGNOSTIC", JSON.stringify({ legacyShared, sharedInstall, sharedContent, isolatedSessions, sharedPinned, sharedDisabled, sharedEnabled, survivesAccountDeletion, survivesReopen, sharedRemoved }));
    if (second) await closeDesktopWebView(second.id);
    const menuRemoved = !readState().webExtensionMenus?.[managed.lastUrlKey]?.[added.extensionId];
    await downloadPage.loadURL(`${managed.entryOrigin}/upload`);
    await waitForDesktopWebTitle(managed, "Upload fixture");
    const removed = await downloadPage.executeJavaScript('document.documentElement.dataset.vironInstalled === undefined') as boolean;
    await enableDesktopChromeWebStore(managed);
    const storeFixture = join(app.getPath("userData"), "web-store-downloads", managed.lastUrlKey, "store-smoke", "1.0.0_0");
    await mkdir(storeFixture, { recursive: true });
    await writeFile(join(storeFixture, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Store smoke extension", version: "1.0.0" }));
    await managed.partition.extensions.loadExtension(storeFixture);
    let storeImported = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const entry = listDesktopWebExtensions(managed.partition, managed.lastUrlKey).find((item) => item.name === "Store smoke extension");
      if (entry?.loaded) {
        storeImported = true;
        await removeDesktopWebExtension(managed.partition, managed.lastUrlKey, entry.installId);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    extensionManaged = pinned && disabled && enabled && hasPopup && popupRendered && compactPopupFits && expandedPopupFits && popupTargetsWebPage && translationApplied && popupClosedOnBlur && extensionMenuRendered && extensionMenuClicked && menuPersisted && menuRemoved && applied && removed && storeImported;
    if (!extensionManaged) console.log("VIRON_EXTENSION_DIAGNOSTIC", JSON.stringify({ pinned, disabled, enabled, hasPopup, popupRendered, compactPopupSize, compactPopupFits, expandedPopupSize, expandedPopupFits, popupTargetsWebPage, translationApplied, popupClosedOnBlur, extensionMenuRendered, extensionMenuClicked, menuPersisted, menuRemoved, applied, removed, storeImported }));
  }
  if (!(extensionLoaded && extensionOnFirstPage && extensionAfterReopen && extensionAfterReset)) {
    const error = await activeDesktopWebPage(managed).view.webContents.executeJavaScript('document.documentElement.dataset.vironExtensionError') as string | undefined;
    console.log("VIRON_EXTENSION_MARKER", JSON.stringify({ extensionLoaded, extensionOnFirstPage, extensionAfterReopen, extensionAfterReset, error }));
  }
  return { opened: true, blankOpenedWithoutEntry: blankOpenedWithoutEntry && shorthandAddressLoaded && defaultAddressPreserved, manualRefillOnCurrentPage, sessionStatePersisted, extensionProfilePersisted, lastLocationRestored, tabsReordered, popupPreservesOpener, inspectorOpened: true, resetCleared, extensionInjected: extensionLoaded && extensionOnFirstPage && extensionAfterReopen && extensionAfterReset, extensionManaged, extensionGlobal, uploadSelected, downloadTriggered: true };
}
