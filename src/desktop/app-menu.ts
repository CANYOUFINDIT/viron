import { app, Menu } from "electron";
import { translate as tr } from "./i18n.js";
import {
  electronAccelerator,
  sendShortcutAction,
  shortcutPreferences,
} from "./app-state.js";
import { mainWindow } from "./window-host.js";

export function installApplicationMenu(): void {
  const bindings = shortcutPreferences().bindings;
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        { label: tr("设置…"), accelerator: electronAccelerator(bindings["app.settings"]), click: () => sendShortcutAction("app.settings") },
        { type: "separator" as const },
        { role: "services" as const },
        { type: "separator" as const },
        { role: "hide" as const },
        { role: "hideOthers" as const },
        { role: "unhide" as const },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    }] : []),
    {
      label: tr("文件"),
      submenu: [
        { label: tr("新建当前对象"), accelerator: electronAccelerator(bindings["workspace.new"]), click: () => sendShortcutAction("workspace.new") },
        { label: tr("设计当前对象"), accelerator: electronAccelerator(bindings["workspace.design"]), click: () => sendShortcutAction("workspace.design") },
        { label: tr("保存或提交"), accelerator: electronAccelerator(bindings["workspace.save"]), click: () => sendShortcutAction("workspace.save") },
        { type: "separator" },
        { label: tr("关闭当前页签"), accelerator: electronAccelerator(bindings["workspace.close"]), click: () => sendShortcutAction("workspace.close") },
        { label: tr("关闭窗口"), accelerator: "CommandOrControl+Shift+W", click: () => mainWindow?.close() },
      ],
    },
    {
      label: tr("编辑"),
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: tr("显示"),
      submenu: [
        { label: tr("搜索当前内容"), accelerator: electronAccelerator(bindings["workspace.search"]), click: () => sendShortcutAction("workspace.search") },
        { label: tr("刷新当前内容"), accelerator: electronAccelerator(bindings["workspace.refresh"]), click: () => sendShortcutAction("workspace.refresh") },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: tr("窗口"),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin" ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
