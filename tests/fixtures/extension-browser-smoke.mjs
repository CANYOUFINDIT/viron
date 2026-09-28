import { app, BrowserWindow, WebContentsView, session, nativeImage } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

async function run() {
  const directory = process.env.VIRON_EXTENSION_TEST_DIR;
  app.setPath('userData', directory);
  await app.whenReady();
  const api = await import(pathToFileURL(resolve('dist/desktop/web-extension-browser.js')));
  const menus = await import(pathToFileURL(resolve('dist/desktop/web-extension-context-menus.js')));
  menus.registerDesktopWebExtensionContextMenus();
  const partition = session.fromPartition('persist:extension-first');
  const second = session.fromPartition('persist:extension-second');
  for (const [index, item] of [partition, second].entries()) {
    const preload = resolve('dist/desktop/web-extension-compat-preload.cjs');
    item.registerPreloadScript({ type: 'frame', filePath: preload });
    item.registerPreloadScript({ type: 'service-worker', filePath: preload });
    menus.registerDesktopWebExtensionWorkerMenus(item, String(index + 1).repeat(64));
  }
  const extensionPath = join(directory, 'extension');
  await mkdir(extensionPath);
  await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Generic screenshot fixture', version: '1.0.0', permissions: ['contextMenus', 'storage', 'activeTab', 'scripting'],
    commands: { capture: { suggested_key: { default: 'Alt+Shift+Y' }, description: 'Capture page' } }, background: { service_worker: 'worker.js' },
  }));
  await writeFile(join(extensionPath, 'worker.js'), `
    chrome.commands.onCommand.addListener(async (name, tab) => chrome.storage.local.set({ command: name, tabId: tab.id }));
    chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'capture', title: 'Capture page', contexts: ['all'] })));
    chrome.runtime.onMessage.addListener((message, sender, respond) => { if (message.fromContent) respond({ id: sender.tab.id, frameId: sender.frameId }); });
  `);
  await writeFile(join(extensionPath, 'popup.html'), '<!doctype html><title>Fixture popup</title>');
  await writeFile(join(extensionPath, 'result.html'), '<!doctype html><title>Result</title>');
  await writeFile(join(extensionPath, 'content.js'), `
    globalThis.extensionOnly = 'isolated';
    chrome.runtime.onConnect.addListener(port => port.onMessage.addListener(message => port.postMessage({ echo: message, title: document.title })));
    chrome.runtime.sendMessage({ fromContent: true }).then(reply => document.documentElement.dataset.sender = JSON.stringify(reply));
  `);
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Capture fixture</title><body style="background:teal;height:1400px">Fixture</body>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const window = new BrowserWindow({ width: 800, height: 600, show: true });
  const views = new Map();
  const create = (partition, target, active = true) => {
    const view = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    views.set(view.webContents.id, view);
    window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 800, height: 560 });
    const select = () => { for (const candidate of views.values()) candidate.setVisible(candidate === view); api.selectExtensionTab(view.webContents); };
    api.registerExtensionTab(view.webContents, { windowId: window.id, bounds: () => view.getBounds(), select, remove: () => { views.delete(view.webContents.id); view.webContents.close(); } });
    if (active) select();
    void view.webContents.loadURL(target);
    return view.webContents;
  };
  api.registerExtensionBrowser(partition, { create: (url, active) => create(partition, url, active) });
  const page = create(partition, url);
  const other = create(second, url, false); api.selectExtensionTab(other);
  const extension = await partition.extensions.loadExtension(extensionPath);
  const popup = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await popup.webContents.loadURL(`chrome-extension://${extension.id}/popup.html`);
  const evaluate = code => popup.webContents.executeJavaScript(code);
  const until = async callback => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Extension fixture timed out');
  };
  await until(() => !page.isLoading());
  const params = { pageURL: url, frameURL: '', linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false };
  await until(() => menus.desktopWebExtensionContextMenuItems(partition, page, params).length === 1);
  assert.equal(menus.desktopWebExtensionContextMenuItems(partition, page, params)[0].label, 'Capture page');
  assert.equal(menus.desktopWebExtensionContextMenuItems(second, other, params).length, 0);
  const query = await evaluate('chrome.tabs.query({active:true,currentWindow:true})');
  assert.deepEqual(query.map(tab => tab.id), [page.id]);
  assert.match(await evaluate(`chrome.tabs.get(${other.id}).catch(e=>e.message)`), /No tab/);
  assert.match(await evaluate('chrome.tabs.captureVisibleTab(undefined,{format:"png"}).catch(e=>e.message)'), /user gesture/);
  api.grantExtensionActiveTab(partition, extension.id, page.id);
  await evaluate(`chrome.scripting.executeScript({target:{tabId:${page.id}},files:['content.js']})`);
  await until(async () => Boolean(await page.executeJavaScript('document.documentElement.dataset.sender')));
  assert.deepEqual(JSON.parse(await page.executeJavaScript('document.documentElement.dataset.sender')), { id: page.id, frameId: 0 });
  assert.equal(await page.executeJavaScript('typeof extensionOnly'), 'undefined');
  const result = await evaluate(`chrome.scripting.executeScript({target:{tabId:${page.id}},args:[2,3],func:(a,b)=>a+b})`);
  assert.equal(result[0].result, 5);
  const reply = await evaluate(`new Promise(resolve=>{const port=chrome.tabs.connect(${page.id});port.onMessage.addListener(message=>{port.disconnect();resolve(message)});port.postMessage('hello')})`);
  assert.deepEqual(reply, { echo: 'hello', title: 'Capture fixture' });
  const capture = await evaluate('chrome.tabs.captureVisibleTab(undefined,{format:"png"})');
  assert.ok(nativeImage.createFromDataURL(capture).getSize().height >= 560);
  const created = await evaluate('chrome.tabs.create({url:"result.html",active:false})');
  assert.ok(views.has(created.id));
  await evaluate(`chrome.tabs.remove(${created.id})`); assert.equal(views.has(created.id), false);
  assert.equal(api.handleExtensionShortcut(page, { type: 'keyDown', key: 'Y', alt: true, shift: true, meta: false, control: false, isAutoRepeat: false }), true);
  await until(async () => (await evaluate('chrome.storage.local.get("command")')).command === 'capture');
  menus.clearDesktopWebExtensionContextMenus(partition, extension.id);
  menus.restoreDesktopWebExtensionContextMenus(partition, '1'.repeat(64), extension.id);
  assert.equal(menus.desktopWebExtensionContextMenuItems(partition, page, params)[0].label, 'Capture page');
  await page.loadURL(url + '?navigation=1');
  assert.match(await evaluate('chrome.tabs.captureVisibleTab(undefined,{format:"png"}).catch(e=>e.message)'), /user gesture/);
  api.closeExtensionBrowser(partition);
  server.close();
  console.log('EXTENSION_BROWSER_PASS');
  app.exit(0);
}
void run().catch(error => { console.error(error); app.exit(1); });
