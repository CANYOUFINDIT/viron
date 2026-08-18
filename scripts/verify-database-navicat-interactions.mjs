import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, request } from "playwright-core";
import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(".env") });

const baseUrl = process.env.VIRON_NAVICAT_BASE_URL || "http://127.0.0.1:5173";
const browserPath = process.env.VIRON_NAVICAT_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const databaseName = process.env.DATABASE_NAME || "viron";
const connectionPrefix = "__codex_navicat_parity__";
const connectionName = `${connectionPrefix}${process.pid}`;
const outputDirectory = resolve(".tmp/database-navicat-acceptance");
const metadataTimeout = 90_000;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name}，无法执行数据库交互验收`);
  return value;
}

async function expectOk(response, label) {
  if (response.ok()) return response;
  throw new Error(`${label}失败：${response.status()} ${await response.text()}`);
}

async function actionOrder(locator) {
  return locator.locator("[data-navicat-action]").evaluateAll((items) => items
    .filter((item) => item instanceof HTMLElement && item.offsetParent !== null)
    .map((item) => item.getAttribute("data-navicat-action")));
}

async function buttonTexts(locator) {
  return locator.locator("button").evaluateAll((items) => items
    .filter((item) => item.offsetParent !== null)
    .map((item) => item.textContent?.replace(/\s+/g, "").trim())
    .filter(Boolean));
}

async function assertControlPalette(locator, theme, label) {
  const themeState = await locator.evaluate((element) => {
    const workbench = element.closest(".database-workbench");
    return {
      rootClass: document.documentElement.className,
      workbenchFill: workbench ? getComputedStyle(workbench).getPropertyValue("--el-fill-color-blank").trim() : "",
    };
  });
  const controls = await locator.locator(".el-input__wrapper:visible, .el-select__wrapper:visible, .el-textarea__inner:visible").evaluateAll((items) => items.map((item) => {
    const field = item.closest(".el-input, .el-select, .el-textarea");
    const input = item.querySelector("input, textarea");
    return {
      background: getComputedStyle(item).backgroundColor,
      name: field?.getAttribute("aria-label") || input?.getAttribute("aria-label") || input?.getAttribute("placeholder") || item.className,
    };
  }));
  assert(controls.length, `${label}没有可检查的输入控件`);
  const offenders = controls.filter((control) => {
    const channels = control.background.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    if (channels.length !== 3) return true;
    const scale = control.background.startsWith("color(srgb ") ? 255 : 1;
    const average = channels.reduce((sum, channel) => sum + channel * scale, 0) / channels.length;
    return theme === "dark" ? average > 140 : average < 180;
  });
  assert.deepEqual(offenders, [], `${label}存在未适配${theme === "dark" ? "暗色" : "亮色"}主题的输入控件；${JSON.stringify(themeState)}`);
}

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: process.env.VIRON_NAVICAT_HEADED !== "1",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const api = await request.newContext({ baseURL: baseUrl });
let connectionId = "";

try {
  await mkdir(outputDirectory, { recursive: true });
  await expectOk(await api.post("/api/v1/auth/login", {
    data: { username: required("ADMIN_USERNAME"), password: required("ADMIN_PASSWORD") },
  }), "API 登录");
  const apiState = await api.storageState();
  await context.addCookies(apiState.cookies);
  await page.goto(`${baseUrl}/database`, { waitUntil: "domcontentloaded" });
  if (page.url().includes("/login")) throw new Error("浏览器验收会话未能恢复登录状态");

  const existing = await expectOk(await api.get("/api/v1/connections?type=database"), "读取临时连接");
  for (const item of (await existing.json()).items || []) {
    if (String(item.name).startsWith(connectionPrefix)) {
      await expectOk(await api.delete(`/api/v1/database-connections/${item.id}`), "清理旧临时连接");
    }
  }

  const created = await expectOk(await api.post("/api/v1/database-connections", {
    data: {
      name: connectionName,
      engine: "mysql",
      host: required("DATABASE_HOST"),
      port: Number(required("DATABASE_PORT")),
      username: required("DATABASE_USERNAME"),
      credential: { password: required("DATABASE_PASSWORD") },
      defaultDatabase: databaseName,
      connectionMode: "tcp",
    },
  }), "创建临时连接");
  connectionId = (await created.json()).id;

  await page.goto(`${baseUrl}/database`, { waitUntil: "networkidle" });
  const globalToolbar = page.locator(".database-global-toolbar");
  await globalToolbar.waitFor({ state: "visible", timeout: 30_000 });
  assert.deepEqual(await actionOrder(globalToolbar), [
    "connection", "new-query", "table", "view", "function", "user", "event", "query", "backup",
    "navigation-pane", "information-pane",
  ]);
  assert.equal(await globalToolbar.locator('[data-navicat-action="automation"]').count(), 0, "自动运行完整交付前不应显示全局入口");
  assert.equal(await globalToolbar.locator('[data-navicat-action="model"]').count(), 0, "模型完整交付前不应显示全局入口");
  assert.equal(await globalToolbar.locator('[data-navicat-action="bi"]').count(), 0, "BI 完整交付前不应显示全局入口");

  const backupBox = await globalToolbar.locator('[data-navicat-action="backup"]').boundingBox();
  const navigationBox = await globalToolbar.locator('[data-navicat-action="navigation-pane"]').boundingBox();
  const informationBox = await globalToolbar.locator('[data-navicat-action="information-pane"]').boundingBox();
  const vironBox = await globalToolbar.locator('[data-viron-action="extensions"]').boundingBox();
  assert(backupBox && navigationBox && informationBox && vironBox, "全局工具栏按钮不可见");
  assert(backupBox.x < navigationBox.x && navigationBox.x < informationBox.x && informationBox.x < vironBox.x, "Viron 扩展菜单打乱了 Navicat 全局工具栏顺序");

  const connection = page.getByRole("button", { name: connectionName, exact: true });
  await connection.click();
  assert.equal(await globalToolbar.locator('[data-navicat-action="new-query"]').isDisabled(), true, "单击连接不应建立会话");
  assert.match(await connection.locator("..").getAttribute("class") || "", /is-selected/, "单击连接应只更新选中态");

  await connection.dblclick();
  await page.locator("button.schema-node", { hasText: databaseName }).waitFor({ timeout: metadataTimeout });
  assert.equal(await globalToolbar.locator('[data-navicat-action="new-query"]').isEnabled(), true, "双击连接后工具栏应可用");

  const schemaBranch = page.locator(".schema-branch", {
    has: page.locator("button.schema-node", { hasText: new RegExp(`^${databaseName}$`) }),
  });
  const schemaButton = schemaBranch.locator("button.schema-node");
  await schemaButton.click();
  assert.equal(await schemaBranch.locator(".schema-children").count(), 0, "单击数据库不应展开对象分类");
  await schemaButton.dblclick();
  await schemaBranch.locator(".schema-children").waitFor();
  assert.deepEqual(await schemaBranch.locator(".schema-category-node span").allTextContents(), ["表", "视图", "函数", "事件", "查询", "备份"]);

  const completionMetadataResponse = page.waitForResponse((response) => (
    response.request().method() === "GET"
      && response.url().includes(`/api/v1/database-connections/${connectionId}/completion-metadata`)
      && response.url().includes(`database=${encodeURIComponent(databaseName)}`)
  ), { timeout: metadataTimeout });
  await globalToolbar.locator('[data-navicat-action="new-query"]').click();
  const queryToolbar = page.locator(".navicat-query-toolbar");
  await queryToolbar.waitFor();
  await assertControlPalette(queryToolbar, "dark", "查询工具栏");
  assert.deepEqual(await actionOrder(queryToolbar), [
    "save", "beautify", "code-snippet", "result-below", "result-right", "focus",
    "connection", "database", "run", "explain",
  ]);
  assert.equal(await queryToolbar.locator('[data-navicat-action="query-builder"]').count(), 0, "查询创建工具完整交付前不应显示");
  assert.equal(await queryToolbar.getByRole("button", { name: "历史" }).count(), 0, "执行历史不应插入 Navicat 查询按钮序列");
  assert.equal(await queryToolbar.locator('[data-navicat-action="stop"]').count(), 0, "空闲查询不应显示停止按钮");

  await queryToolbar.getByRole("button", { name: "运行菜单" }).click();
  for (const label of ["运行", "运行当前语句", "运行已选择的", "遇到错误时继续"]) {
    await page.getByRole("menuitem", { name: label, exact: true }).waitFor();
  }
  await page.keyboard.press("Escape");

  const editor = page.locator(".monaco-editor").first();
  const completionResponse = await completionMetadataResponse;
  assert.equal(completionResponse.ok(), true, `读取 SQL 补全元数据失败：${completionResponse.status()}`);
  const completion = await completionResponse.json();
  const completionObject = completion.objects?.find((item) => item.columns?.length);
  assert(completionObject, "当前数据库没有可用于 SQL 补全验收的表或视图");
  const completionColumn = completionObject.columns[0];
  const completionPrefix = completionObject.name.slice(0, Math.min(4, completionObject.name.length));
  const quotedObject = `\`${completionObject.name.replaceAll("`", "``")}\``;
  const editorInput = editor.locator("textarea.inputarea");
  await editor.locator(".view-lines").click({ position: { x: 120, y: 24 } });
  assert.equal(await editorInput.evaluate((input) => document.activeElement === input), true, "SQL 编辑器没有获得输入焦点");
  await page.keyboard.insertText(`SELECT * FROM ${completionPrefix}`);
  await page.keyboard.press("Control+Space");
  const suggestWidget = page.locator(".monaco-editor .suggest-widget.visible");
  await suggestWidget.locator(".monaco-list-row", { hasText: completionObject.name }).first().waitFor({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await suggestWidget.waitFor({ state: "hidden" });
  await page.keyboard.press("Meta+KeyA");
  await page.keyboard.insertText(`SELECT * FROM ${quotedObject} d WHERE d`);
  await page.keyboard.type(".");
  await suggestWidget.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const aliasSuggestionTexts = await suggestWidget.locator(".monaco-list-row").allTextContents();
  const aliasSuggestionText = aliasSuggestionTexts.find((text) => text.includes(completionColumn.name)) ?? "";
  const aliasEditorText = await editor.locator(".view-lines").innerText();
  assert(aliasSuggestionText, `别名后没有提示目标字段；SQL=${JSON.stringify(aliasEditorText)}；候选=${JSON.stringify(aliasSuggestionTexts.slice(0, 12))}`);
  assert(aliasSuggestionText.includes(completionColumn.columnType), `别名字段没有显示类型：${JSON.stringify(aliasSuggestionText)}`);
  assert(aliasSuggestionText.includes(`${databaseName}.${completionObject.name}`), `别名字段没有显示来源：${JSON.stringify(aliasSuggestionText)}`);
  await page.keyboard.press("Escape");
  await suggestWidget.waitFor({ state: "hidden" });
  await page.keyboard.press("Meta+KeyA");
  await page.keyboard.insertText("SE");
  await page.keyboard.press("Control+Space");
  await suggestWidget.waitFor({ timeout: 10_000 });
  assert((await suggestWidget.locator(".monaco-list-row").allTextContents()).some((text) => text.includes("SELECT")), "输入 SE 后没有提示 SELECT 关键字");
  await page.screenshot({ path: resolve(outputDirectory, "sql-completion.png") });
  await page.keyboard.press("Escape");
  await suggestWidget.waitFor({ state: "hidden" });
  await page.keyboard.press("Meta+KeyA");
  await page.keyboard.insertText("SELECT 1 AS navicat_parity");
  await queryToolbar.locator('[data-navicat-action="run"]').click();
  await page.getByText("navicat_parity", { exact: true }).waitFor({ timeout: 30_000 });

  await editorInput.focus();
  await page.keyboard.press("Meta+KeyF");
  await page.locator(".monaco-editor .find-widget.visible").waitFor();
  await page.keyboard.press("Escape");

  await globalToolbar.locator('[data-navicat-action="table"]').click();
  await page.getByRole("menuitem", { name: "打开表列表" }).click();
  const objectBrowser = page.locator(".database-object-browser:not(.database-utility-browser)");
  await objectBrowser.waitFor({ timeout: 30_000 });
  await assertControlPalette(objectBrowser, "dark", "数据库对象列表");
  assert.deepEqual((await buttonTexts(objectBrowser.locator(".object-toolbar-actions"))).slice(0, 7), [
    "打开表", "设计表", "新建表", "删除表", "导入向导", "导出向导", "刷新",
  ]);

  const firstTable = objectBrowser.locator(".database-object-table tbody tr").first();
  await firstTable.waitFor({ timeout: metadataTimeout });
  const tableNames = (await objectBrowser.locator(".database-object-table tbody .object-name-cell").allInnerTexts())
    .map((text) => text.split("\n")[0].trim())
    .filter(Boolean);
  const firstTableName = (await firstTable.locator(".object-name-cell").innerText()).split("\n")[0].trim();
  const secondTableName = tableNames.find((name) => name !== firstTableName);
  const tableCategory = schemaBranch.locator(".schema-category", {
    has: page.locator(".schema-category-node", { hasText: /^表$/ }),
  });
  await tableCategory.locator(".schema-category-toggle").click();
  const navigatorTable = tableCategory.locator(".schema-object-main", { hasText: firstTableName }).first();
  await navigatorTable.waitFor({ timeout: metadataTimeout });
  await navigatorTable.click();
  await page.waitForFunction((tableName) => {
    const selected = document.querySelector(".database-object-table tbody tr.is-selected .object-name-cell");
    return selected?.textContent?.trim().startsWith(tableName);
  }, firstTableName);
  await globalToolbar.locator('[data-navicat-action="table"]').click();
  await page.getByRole("menuitem", { name: "导入向导" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入表格数据" });
  await importDialog.waitFor({ timeout: 30_000 });
  assert.equal(await importDialog.locator(".el-input__inner").first().inputValue(), `${databaseName}.${firstTableName}`, "左侧树选中表没有成为全局导入目标");
  await importDialog.getByRole("button", { name: "取消", exact: true }).click();
  const visibleTableEditor = () => page.locator(".table-data-editor:visible");
  const tableToolbar = visibleTableEditor().locator(".table-data-toolbar");
  await tableToolbar.waitFor({ timeout: 30_000 });
  assert.deepEqual(await actionOrder(tableToolbar), ["data-view", "transaction", "editor", "filter-sort", "columns", "tools", "focus"]);
  assert.equal(await tableToolbar.locator('[data-navicat-action="data-analysis"]').count(), 0, "逐列数据分析完整交付前不应显示");
  const commandbar = visibleTableEditor().locator(".table-data-commandbar");
  assert.deepEqual(await actionOrder(commandbar), [
    "add-record", "delete-record", "commit", "rollback", "refresh", "stop", "first-page", "previous-page",
    "page-number", "next-page", "last-page", "page-size", "grid-view", "form-view",
  ]);

  await tableToolbar.locator('[data-navicat-action="filter-sort"]').click();
  const filterEditor = visibleTableEditor().locator(".table-filter-sort-editor");
  await filterEditor.getByText("排序方式", { exact: true }).waitFor();
  await assertControlPalette(filterEditor, "dark", "筛选与排序面板");
  const filterRule = filterEditor.locator(".table-rule-row.is-filter").first();
  await filterRule.locator(".el-select").nth(0).click();
  await page.locator(".el-select-dropdown:visible .el-select-dropdown__item").first().click();
  const suggestionResponse = page.waitForResponse(
    (response) => response.url().includes(`/api/v1/database-connections/${connectionId}/table-data/suggestions?`),
    { timeout: metadataTimeout },
  );
  await filterRule.locator(".el-select").nth(2).click();
  const suggestionHttpResponse = await suggestionResponse;
  await expectOk(suggestionHttpResponse, "读取筛选建议值");
  const suggestionPayload = await suggestionHttpResponse.json();
  assert(Array.isArray(suggestionPayload.items), "筛选建议值接口没有返回数组");
  if (suggestionPayload.items.length) {
    await page.locator(".el-select-dropdown:visible .el-select-dropdown__item", { hasText: String(suggestionPayload.items[0]) }).first().waitFor();
  }
  await page.keyboard.press("Escape");

  const sortRule = filterEditor.locator(".table-rule-row.is-sort").first();
  await sortRule.locator(".el-select").first().click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await filterRule.locator(".el-checkbox").click();
  const sortedRequest = page.waitForRequest((request) => request.method() === "GET" && request.url().includes(`/api/v1/database-connections/${connectionId}/table-data?`) && new URL(request.url()).searchParams.has("sorts"));
  await filterEditor.getByRole("button", { name: "应用筛选与排序", exact: true }).click();
  const appliedSorts = JSON.parse(new URL((await sortedRequest).url()).searchParams.get("sorts") || "[]");
  assert.equal(appliedSorts.length, 1, "表数据请求没有携带排序规则");
  await visibleTableEditor().locator(".table-data-statusbar").click();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  const findbar = visibleTableEditor().locator(".table-findbar");
  await findbar.waitFor();
  await assertControlPalette(visibleTableEditor(), "dark", "表数据暗色控件");
  const firstCellText = await visibleTableEditor().locator(".tabulator-row .tabulator-cell").evaluateAll((cells) => cells
    .map((cell) => cell.textContent?.trim() || "")
    .find((text) => text && text !== "NULL") || "");
  if (firstCellText) {
    await findbar.locator('input[type="search"]').fill(firstCellText.slice(0, 24));
    await visibleTableEditor().locator(".tabulator-cell.is-current-find-match").first().waitFor();
  }
  await page.screenshot({ path: resolve(outputDirectory, "table-data-filter-sort-find.png") });
  await page.evaluate(() => document.documentElement.classList.add("bright"));
  await page.waitForFunction(() => document.documentElement.classList.contains("bright"));
  await page.waitForTimeout(400);
  await assertControlPalette(visibleTableEditor(), "light", "表数据亮色控件");
  await page.screenshot({ path: resolve(outputDirectory, "table-data-filter-sort-find-bright.png") });
  await page.evaluate(() => document.documentElement.classList.remove("bright"));
  await page.waitForTimeout(400);
  await findbar.getByRole("button", { name: "完成", exact: true }).click();

  if (secondTableName) {
    let tableDataRequestCount = 0;
    const countTableDataRequest = (request) => {
      if (request.method() === "GET" && request.url().includes(`/api/v1/database-connections/${connectionId}/table-data?`)) tableDataRequestCount += 1;
    };
    page.on("request", countTableDataRequest);
    const secondNavigatorTable = page.locator(".schema-object-main:visible", { hasText: secondTableName }).first();
    await secondNavigatorTable.dblclick();
    const firstDataTab = page.locator(".query-tabs > button", { hasText: `${firstTableName}@${databaseName}` }).first();
    const secondDataTab = page.locator(".query-tabs > button", { hasText: `${secondTableName}@${databaseName}` }).first();
    await page.locator(".query-tabs > button.is-active", { hasText: `${secondTableName}@${databaseName}` }).waitFor({ timeout: metadataTimeout });
    await visibleTableEditor().locator(".table-data-statusbar").waitFor({ timeout: metadataTimeout });
    const requestsAfterSecondOpen = tableDataRequestCount;
    assert(requestsAfterSecondOpen >= 1, "打开第二张数据表应请求表数据");
    await firstDataTab.click();
    await page.locator(".query-tabs > button.is-active", { hasText: `${firstTableName}@${databaseName}` }).waitFor();
    await visibleTableEditor().locator(".table-data-statusbar").waitFor();
    await page.waitForTimeout(700);
    assert.equal(tableDataRequestCount, requestsAfterSecondOpen, "切回已打开数据表不应重新请求表数据");
    await secondDataTab.click();
    await page.locator(".query-tabs > button.is-active", { hasText: `${secondTableName}@${databaseName}` }).waitFor();
    await visibleTableEditor().locator(".table-data-statusbar").waitFor();
    await page.waitForTimeout(700);
    assert.equal(tableDataRequestCount, requestsAfterSecondOpen, "再次切换已打开数据表不应重新请求表数据");
    await firstDataTab.click();
    await page.locator(".query-tabs > button.is-active", { hasText: `${firstTableName}@${databaseName}` }).waitFor();
    page.off("request", countTableDataRequest);
  }

  const profileName = `验收配置-${process.pid}`;
  await tableToolbar.locator('[data-navicat-action="data-view"]').click();
  await page.getByRole("menuitem", { name: "保存配置文件" }).click();
  const saveProfileDialog = page.getByRole("dialog", { name: "保存配置文件" });
  await saveProfileDialog.getByRole("textbox").fill(profileName);
  await saveProfileDialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".table-data-statusbar", { hasText: profileName }).waitFor();
  await tableToolbar.locator('[data-navicat-action="data-view"]').click();
  await page.getByRole("menuitem", { name: "管理配置文件…" }).click();
  const profileManager = page.getByRole("dialog", { name: "管理表配置文件" });
  await profileManager.getByText(profileName, { exact: true }).waitFor();
  await profileManager.getByRole("button", { name: "关闭", exact: true }).click();
  await commandbar.locator('[data-navicat-action="form-view"]').click();
  assert.match(await commandbar.locator('[data-navicat-action="form-view"]').getAttribute("class") || "", /is-active/, "表单视图没有激活");
  await assertControlPalette(visibleTableEditor(), "dark", "表单视图");
  await tableToolbar.locator('[data-navicat-action="data-view"]').click();
  await page.getByRole("menuitem", { name: `加载 · ${profileName}`, exact: true }).click();
  assert.match(await commandbar.locator('[data-navicat-action="grid-view"]').getAttribute("class") || "", /is-active/, "加载配置文件没有恢复网格视图");
  await visibleTableEditor().locator(".table-data-statusbar", { hasText: profileName }).waitFor();

  await visibleTableEditor().locator(".table-data-statusbar").click();
  const shortcutDesignResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/database-connections/${connectionId}/table-design`
      && url.searchParams.get("database") === databaseName
      && url.searchParams.get("table") === firstTableName;
  }, { timeout: metadataTimeout });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+d" : "Control+d");
  const shortcutDesigner = page.locator(".table-designer:visible");
  await shortcutDesigner.waitFor({ timeout: metadataTimeout });
  await page.locator(".query-tabs > button.is-active", { hasText: `设计 ${firstTableName}@${databaseName}` }).waitFor();
  const shortcutDesignHttpResponse = await shortcutDesignResponse;
  await expectOk(shortcutDesignHttpResponse, "Command/Ctrl+D 读取表结构");
  const shortcutDesign = (await shortcutDesignHttpResponse.json()).design;
  assert(shortcutDesign?.fields?.length, "Command/Ctrl+D 打开的表结构没有字段");
  await page.waitForFunction((fieldName) => [...document.querySelectorAll(".table-designer .table-designer-fields tbody tr input")]
    .some((input) => input instanceof HTMLInputElement && input.offsetParent !== null && input.value === fieldName), shortcutDesign.fields[0].name, { timeout: metadataTimeout });
  await shortcutDesigner.locator(".el-loading-mask").waitFor({ state: "hidden", timeout: metadataTimeout });
  await page.screenshot({ path: resolve(outputDirectory, "table-designer-command-d.png") });
  await page.locator('.query-tabs > button.is-active [aria-label="关闭页签"]').click();
  await visibleTableEditor().waitFor();

  await globalToolbar.locator('[data-navicat-action="table"]').click();
  await page.getByRole("menuitem", { name: "新建表" }).click();
  const designer = page.locator(".table-designer");
  await designer.waitFor();
  await assertControlPalette(designer, "dark", "表设计器");
  assert.deepEqual(await actionOrder(designer.locator(".table-designer-toolbar")), ["save", "add", "insert", "delete", "focus"]);
  assert.deepEqual(await designer.locator(".table-designer-tabs button").allTextContents(), ["字段", "索引", "外键", "触发器", "检查", "选项", "注释", "SQL 预览"]);
  for (const label of ["填充零", "键长度", "字符集", "排序规则", "二进制", "列格式", "存储"]) {
    await designer.getByText(label, { exact: true }).waitFor();
  }
  await designer.locator(".table-designer-tabs button", { hasText: "选项" }).click();
  for (const label of ["数据目录:", "索引目录:", "延迟键写入:", "封装键:", "校验和:", "统计数据持久:", "统计自动重计:"]) {
    await designer.getByText(label, { exact: true }).waitFor();
  }
  await page.setViewportSize({ width: 900, height: 720 });
  await page.evaluate(() => document.documentElement.classList.add("bright"));
  await assertControlPalette(designer, "light", "亮色表设计器");
  for (const action of ["save", "add", "insert", "delete", "focus"]) {
    await designer.locator(`[data-navicat-action="${action}"]`).waitFor({ state: "visible" });
  }
  await page.screenshot({ path: resolve(outputDirectory, "table-designer-bright-narrow.png") });
  await page.evaluate(() => document.documentElement.classList.remove("bright"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.query-tabs > button.is-active [aria-label="关闭页签"]').click();
  await page.getByRole("button", { name: "放弃并关闭" }).click();
  await page.locator(".el-overlay-message-box").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  await page.locator(".el-message").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);

  await globalToolbar.locator('[data-navicat-action="backup"]').click();
  await page.getByRole("menuitem", { name: "打开备份列表" }).click();
  const backupBrowser = page.locator(".database-utility-browser");
  await backupBrowser.waitFor();
  assert.deepEqual((await buttonTexts(backupBrowser.locator(".object-toolbar-actions"))).slice(0, 2), ["新建备份", "刷新"]);

  await page.screenshot({ path: resolve(outputDirectory, "web-database-navicat.png"), fullPage: true });
  const tabCountBeforeClose = await page.locator(".query-tabs > button:not(.new-query-tab)").count();
  await schemaButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "关闭数据库", exact: true }).click();
  await page.waitForFunction((database) => {
    const labels = [...document.querySelectorAll(".query-tabs > button:not(.new-query-tab)")].map((element) => element.textContent?.trim() ?? "");
    return labels.every((label) => !label.includes(`@${database}`) && label !== "对象" && label !== "备份");
  }, databaseName);
  const tabCountAfterClose = await page.locator(".query-tabs > button:not(.new-query-tab)").count();
  assert(tabCountAfterClose < tabCountBeforeClose, "关闭数据库没有收起同库子功能页签");
  assert.equal(await schemaBranch.locator(".schema-children").count(), 0, "关闭数据库后左侧对象树仍然展开");
  console.log("数据库 Navicat 交互回归通过");
} finally {
  const browserClosed = await Promise.race([
    browser.close().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!browserClosed) console.warn("浏览器关闭超过 5 秒，继续清理验收资源");
  if (connectionId) {
    let cleaned = false;
    let lastStatus = "request error";
    for (let attempt = 0; attempt < 3 && !cleaned; attempt += 1) {
      const response = await api.delete(`/api/v1/database-connections/${connectionId}`).catch(() => null);
      cleaned = Boolean(response?.ok() || response?.status() === 404);
      lastStatus = String(response?.status() ?? "request error");
      if (!cleaned) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!cleaned) console.error(`临时连接清理失败：${lastStatus}`);
  }
  await api.dispose();
}

process.exit(0);
