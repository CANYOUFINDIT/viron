# 桌面端网页与应用浮层

桌面端 Web 入口使用 Electron `WebContentsView`。它是独立的原生视图，主页面里的 CSS `z-index` 无法把普通 DOM 节点放到它上方。

## 统一规则

- 网页保持实时显示。弹出菜单、对话框或悬浮侧栏时，不截取网页画面，也不为浮层隐藏网页。
- 固定侧栏等占位布局通过正常页面布局为网页留出空间；悬浮侧栏和覆盖网页的浮层由 `src/client/native-dom-overlays.ts` 移入与主窗口同源的原生子窗口。原 Vue 节点、状态和事件处理函数保持不变。
- Element Plus 的 `.el-overlay`、`.el-popper`、`.el-message`、`.el-notification` 自动接入。自定义覆盖组件在最外层加 `data-native-overlay="popover"` 或 `data-native-overlay="modal"`。`modal` 占据整个主窗口内容区并获得键盘焦点；`popover` 使用贴合内容的窗口，避免拦截其余网页区域。
- 主进程的 `src/desktop/overlays/dom-overlay-windows.ts` 验证浮层窗口与位置；`src/desktop/overlays/native-window-stack.ts` 统一排序所有桌面原生浮层。新增原生浮层必须注册到此排序器，视觉层的优先级低于其交互层。
- 浏览器原生内容和应用浮层的鼠标事件属于不同窗口。网页内点击会转发给主页面，用于关闭应用菜单；浮层关闭时节点返回原位置，子窗口随之销毁。

## 新增浮层时

1. 优先使用现有 Element Plus 浮层组件；自定义组件使用 `data-native-overlay` 声明覆盖模式。
2. 让弹出内容本身形成紧凑的矩形。不要用全屏透明窗口承载普通菜单，否则透明区域会挡住网页点击。
3. 键盘输入或确认对话框使用 `modal`。只展示提示或菜单时使用 `popover`，并确保关闭时移除或隐藏其根节点。
4. 运行 `npm run typecheck`、`npm test`、`npm run build:desktop` 和 `npm run verify:desktop-startup`。桌面冒烟测试会检查 Vue 节点跨窗口后的点击、还原，以及浮层显示期间网页持续运行。

平台差异仍需在 macOS 和 Windows 的安装包上检查窗口移动、缩放、全屏、DPI、焦点和真实鼠标命中。冒烟测试是自动回归门槛，不替代交互验收。
