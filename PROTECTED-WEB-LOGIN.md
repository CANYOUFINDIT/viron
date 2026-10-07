# Web 入口后台登录与验收边界

网页版、App 服务端转发模式和 App 本机模式复用 `ProtectedLoginController`、DOM 保护与人工验证组件。服务端使用 Playwright/CDP；本机使用隐藏的 Electron 窗口。浏览器运行位置和数据存储位置不同，登录状态、配置、人工验证与成功判断一致。

## 登录与会话

1. 执行端领取凭据，隐藏认证页面，不向客户端发送其完整截图、DOM、节点句柄或密码。服务端禁止认证期间的普通鼠标、键盘、导航、文件和语义浏览操作；本机暂停扩展及其预加载脚本。
2. 填写一次账号密码，执行声明式登录步骤。按 Origin 校验跳转；未知域名、选择器不唯一、原生对话框或新窗口等不支持的流程保持保护。
3. 需要用户确认时，发送通过检查的局部画面。协议标签打开独立对话框后切换到该对话框；覆盖在背后的凭据输入框会临时隐藏，关闭对话框后恢复。不会替用户同意协议。
4. 普通点击作为一次操作发送；滑块保留连续按下、移动、抬起。区域身份、控件身份与几何位置决定画面版本，页面其他区域刷新及焦点样式不使画面失效。每次输入重新检查真实目标和焦点；旧坐标被丢弃，不能改用新区域重放。
5. 登录成功候选持续稳定后，检查 Cookie、localStorage、sessionStorage 和当前源 IndexedDB 中是否保存了密码。销毁认证文档，以保留的 Cookie/存储及当前源 sessionStorage 打开全新业务文档，再确认业务页面才开放完整画面与普通操作。

有明确成功 selector 时，两次稳定观察各为 300 ms；无标记时分别为 1500 ms。业务文档等待最长 20 秒，自动步骤无进展最长 30 秒，整个认证最长 5 分钟。网络、页面渲染和人工验证仍影响总耗时。不要把提交表单或出现「成功」提示当作完整认证成功。

地址栏在认证网页、业务网页及普通网页加载时显示不确定进度条，不显示虚构的百分比。网页加载、认证等待和业务页面确认分别显示状态；文档加载超时为 30 秒，加载时间不计入随后认证步骤的 30 秒无进展期限。组件表单中唯一的「提交」按钮通过点击调用站点自身处理逻辑，不绕过它执行原生表单提交。

存储检查解析结构化值，只有明确身份字段中与已知用户名完全相同的内容被视为公开身份。密码字段、其他字段及非结构化密码文本仍被拦截；检查也覆盖 JSON 转义后的密码。服务端等待认证页面关闭完成后才创建业务页面。

关闭账号保留该账号的浏览器 profile；显式清除登录状态才重置站点数据。本机扩展安装状态和设置保留。不同执行端不会自动共享 profile。

## 与 JumpServer 官方源码的比对

本次核对了官方 Luna 的 [WebLite 启动入口](https://github.com/jumpserver/luna/blob/8160a2744e34bfdcbfc42a4dea8cf14f39b03930/applets/weblite/src/main.ts)、[共享验证模块](https://github.com/jumpserver/luna/blob/8160a2744e34bfdcbfc42a4dea8cf14f39b03930/packages/web-proxy/src/interaction.ts) 和 [人工验证说明](https://github.com/jumpserver/luna/blob/8160a2744e34bfdcbfc42a4dea8cf14f39b03930/docs/web-proxy-interactive-verification.md)。WebLite 与客户端共享登录模块；人工验证保持目标页面隐藏，按区域身份管理画面版本，串行处理输入，并取消失效拖拽。Viron 独立实现这些原则，认证后额外销毁原文档并验证新业务文档。

JumpServer 官方 [Chrome applet 清单](https://github.com/jumpserver/applets/blob/56549337b196afc544800376cb046486edfa94db/chrome_app/manifest.yml) 使用 Panda/VNC；这与其当前 WebLite 实现是不同运行路径，不能混为一种实现，也不能据此宣称支持全部第三方登录。

## 支持范围和验收

| 场景 | 处理方式 |
| --- | --- |
| 普通表单、同一主页面多步登录 | 自动识别或配置步骤 |
| 协议勾选、可识别的协议对话框 | 局部画面交给用户确认 |
| 主页面中的短信码、验证码、鼠标滑块 | 配置独立验证区域，人工操作 |
| 跨源跳转 | 显式配置允许 Origin |
| Cookie、localStorage、sessionStorage 登录态 | 复用 profile，认证文档销毁后交接 |
| iframe、Shadow DOM、独立弹窗、浏览器原生对话框、硬件认证 | 保持保护，不开放凭据页面；需要独立适配 |

真实浏览器回归覆盖协议勾选后弹出对话框、动画与持续无关 DOM 更新、旧坐标、验证码输入、滑块、失败登录、延迟 SPA、临时跳转、业务重载返回登录、账号隔离与 profile 重开。

每个准备交付的真实站点仍应验收首次登录、协议拒绝/同意、验证码重试、登录失败、会话过期和密码更新；配置稳定的成功 selector。具体第三方 CAPTCHA 和 SSO 不能由模拟测试证明兼容。正常客户端操作的密码保护不等于抵御执行端管理员调试进程，也不等于防御接收密码的恶意目标站点。

回归命令：

```sh
npm run typecheck
npm test
VIRON_WEB_BROWSER_TEST=1 npx vitest run tests/web-browser.integration.test.ts tests/protected-web-server.integration.test.ts tests/protected-web-component-form.integration.test.ts
npm run build:desktop
node_modules/.bin/electron scripts/verify-protected-web-login.mjs
VIRON_DESKTOP_WEB_TEST=1 npx vitest run tests/desktop-local-web.integration.test.ts
```
