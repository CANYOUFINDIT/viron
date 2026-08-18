import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("VIRON_BROWSER_URL", "http://127.0.0.1:8080")
OUTPUT = Path("/tmp/envman-browser-qa-20260716")
OUTPUT.mkdir(parents=True, exist_ok=True)


def screenshot(page, name: str) -> None:
    page.screenshot(path=str(OUTPUT / f"{name}.png"), full_page=True)


def api(page, method: str, path: str, body=None):
    return page.evaluate(
        """async ({method, path, body}) => {
          const response = await fetch(path, {
            method,
            headers: body === null ? undefined : {'Content-Type': 'application/json'},
            body: body === null ? undefined : JSON.stringify(body),
          });
          const text = await response.text();
          if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
          return text ? JSON.parse(text) : null;
        }""",
        {"method": method, "path": path, "body": body},
    )


def find_dark_surfaces(page):
    return page.evaluate(
        """() => {
          const excluded = '.app-sidebar, .app-sidebar *, .theme-preview, .theme-preview *, script, style, svg, path, img, iframe';
          return Array.from(document.querySelectorAll('body *'))
            .filter((element) => !element.matches(excluded) && !element.matches('.el-overlay'))
            .map((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const match = style.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
              if (!match || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05 || rect.width < 12 || rect.height < 12 || rect.width * rect.height < 300) return null;
              const channels = match[1].split(',').map((value) => Number(value.trim()));
              const alpha = channels.length > 3 ? channels[3] : 1;
              if (alpha < 0.35 || Math.max(channels[0], channels[1], channels[2]) >= 100) return null;
              const className = typeof element.className === 'string' && element.className.trim()
                ? `.${element.className.trim().split(/\\s+/).slice(0, 4).join('.')}`
                : '';
              return {
                element: `${element.tagName.toLowerCase()}${className}`,
                background: style.backgroundColor,
                size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
                text: (element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 48),
              };
            })
            .filter(Boolean)
            .slice(0, 30);
        }"""
    )


def assert_no_dark_surfaces(page, label: str, errors: list[str]) -> None:
    surfaces = find_dark_surfaces(page)
    if surfaces:
        errors.append(f"bright theme still has dark surfaces in {label}: {json.dumps(surfaces, ensure_ascii=False)}")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    page = context.new_page()
    errors = []
    failed_requests = []

    page.on("console", lambda message: errors.append(f"console: {message.text}") if message.type == "error" and "status of 401" not in message.text else None)
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on("requestfailed", lambda request: failed_requests.append(f"{request.method} {request.url}: {request.failure}") if "/sftp?" not in request.url else None)
    page.on("response", lambda response: errors.append(f"http {response.status}: {response.url}") if response.status >= 500 else None)

    page.goto(f"{BASE_URL}/login")
    page.wait_for_load_state("networkidle")
    expect(page.get_by_role("heading", name="登录 Viron")).to_be_visible()
    screenshot(page, "00-login-light")
    page.locator('input[autocomplete="username"]').fill("admin")
    page.locator('input[autocomplete="current-password"]').fill("browser-test-password")
    page.get_by_role("button", name="进入运维桌面").click()
    page.wait_for_url(f"{BASE_URL}/")
    page.wait_for_load_state("networkidle")

    group = api(page, "POST", "/api/v1/environment-groups", {"name": "核心业务", "description": "生产与预发环境", "color": "#1d8a74"})
    environment = api(page, "POST", "/api/v1/environments", {
        "groupId": group["id"], "name": "支付生产环境", "shortName": "PAY-PROD", "status": "active",
        "owner": "平台运维组", "description": "订单、支付与清结算服务的生产运行上下文。", "tags": ["生产", "核心"],
    })
    api(page, "POST", "/api/v1/environments", {
        "name": "数据预发环境", "shortName": "DATA-STG", "status": "maintenance",
        "owner": "数据平台组", "description": "用于版本验收和数据任务联调。", "tags": ["预发"],
    })
    entry = api(page, "POST", f"/api/v1/environments/{environment['id']}/web-entries", {
        "name": "支付管理后台", "url": "https://example.com/admin", "description": "运营人员使用的支付后台，仅记录入口。", "tags": ["后台"],
    })
    api(page, "POST", f"/api/v1/web-entries/{entry['id']}/credentials", {
        "username": "ops-admin", "password": "browser-fixture-secret", "note": "值班管理员", "customFields": {},
    })
    ssh_connection = api(page, "POST", "/api/v1/ssh-connections", {
        "environmentId": environment["id"], "name": "支付应用 01", "host": "10.20.1.11", "port": 22,
        "username": "deploy", "authType": "password", "credential": {"password": "browser-fixture-secret"},
    })
    api(page, "POST", "/api/v1/database-connections", {
        "environmentId": environment["id"], "name": "支付主库", "engine": "mariadb", "host": "10.20.2.21", "port": 3306,
        "username": "ops_readwrite", "credential": {"password": "browser-fixture-secret"}, "defaultDatabase": "payments", "connectionMode": "tcp",
    })
    api(page, "POST", f"/api/v1/environments/{environment['id']}/logs", {
        "sshConnectionId": ssh_connection["id"], "name": "支付应用日志", "filePaths": ["/var/log/payment/app.log", "/var/log/payment/error.log"],
    })
    api(page, "POST", "/api/v1/connection-sources/securecrt", {
        "name": "SecureCRT 生产连接", "host": "sync.internal", "port": 22, "username": "sync-user", "authType": "password",
        "password": "browser-fixture-secret", "remotePaths": ["~/Config/Sessions", "~/Config.personal/Sessions"],
        "scheduleEnabled": True, "scheduleExpression": "0 */6 * * *",
    })

    routes = [
        ("/", "环境总览", "01-overview-light"),
        (f"/environments/{environment['id']}", "环境工作区", "02-environment-web"),
        ("/connections", "连接资源池", "03-connections"),
        ("/connection-sources", "连接来源与同步", "04-connection-sources"),
        ("/ssh", "SSH 工作台", "05-ssh-workbench"),
        ("/database", "数据库工作台", "06-database-workbench"),
        ("/audit", "操作审计", "07-audit"),
        ("/settings", "平台设置", "08-settings"),
    ]
    layout = {}
    for path, title, image_name in routes:
        page.goto(f"{BASE_URL}{path}")
        page.wait_for_load_state("networkidle")
        expect(page.locator(".topbar")).to_have_count(0)
        expect(page.locator(".app-content")).to_be_visible()
        dimensions = page.evaluate("({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth})")
        layout[path] = dimensions
        if dimensions["scroll"] > dimensions["width"] + 2:
            errors.append(f"horizontal overflow {path}: {dimensions}")
        if path == "/connection-sources":
            expect(page.get_by_text("0 */6 * * *", exact=True)).to_be_visible()
        screenshot(page, image_name)
        if path.startswith("/environments/"):
            for tab_name, selector, tab_image in [
                ("SSH 终端", ".ssh-workbench", "02-environment-ssh"),
                ("数据库", ".database-workbench", "02-environment-database"),
            ]:
                page.locator(".workspace-tabs button", has_text=tab_name).click()
                expect(page.locator(selector)).to_be_visible()
                page.locator(f"{selector} > .el-loading-mask").wait_for(state="detached")
                screenshot(page, tab_image)

    page.goto(f"{BASE_URL}/")
    page.wait_for_load_state("networkidle")
    expect(page.locator(".header-user-control")).to_be_visible()
    expect(page.get_by_role("button", name="进入沉浸模式")).to_be_visible()
    expect(page.get_by_role("button", name="切换深色主题")).to_have_count(0)
    page.locator(".header-admin-chip").click()
    page.wait_for_url(f"{BASE_URL}/settings?section=profile")
    expect(page.get_by_role("heading", name="个人信息")).to_be_visible()
    expect(page.get_by_text("账号安全", exact=True)).to_have_count(0)
    page.get_by_role("button", name="主题样式").click()
    page.get_by_role("radio", name="切换到深色主题").click()
    expect(page.locator("html")).to_have_class("dark")
    page.goto(f"{BASE_URL}/")
    page.wait_for_load_state("networkidle")
    screenshot(page, "09-overview-dark")

    page.set_viewport_size({"width": 1024, "height": 768})
    page.goto(f"{BASE_URL}/")
    page.wait_for_load_state("networkidle")
    responsive_dimensions = page.evaluate("({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth})")
    if responsive_dimensions["scroll"] > responsive_dimensions["width"] + 2:
        errors.append(f"horizontal overflow 1024px: {responsive_dimensions}")
    screenshot(page, "10-overview-1024-dark")

    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(f"{BASE_URL}/settings?section=appearance")
    page.wait_for_load_state("networkidle")
    page.get_by_role("radio", name="切换到明亮主题").click()
    expect(page.locator("html")).to_have_class("bright")
    expect(page.locator("html")).not_to_have_class("dark")
    settings_visuals = {
        "userControlButtonCount": page.locator(".header-user-control button").count(),
        "lightPreviewConsole": page.locator(".theme-choice.is-light .theme-preview em").evaluate("element => getComputedStyle(element).backgroundColor"),
    }
    if settings_visuals["userControlButtonCount"] != 1:
        errors.append(f"user and settings controls are still separated: {settings_visuals['userControlButtonCount']} buttons")
    preview_channels = [int(value.strip()) for value in settings_visuals["lightPreviewConsole"].removeprefix("rgb(").removesuffix(")").split(",")[:3]]
    if max(preview_channels) > 80:
        errors.append(f"light theme preview console is not dark: {settings_visuals['lightPreviewConsole']}")
    screenshot(page, "11-settings-bright")

    bright_backgrounds = {}
    bright_routes = [
        ("/", "overview"),
        (f"/environments/{environment['id']}", "environment"),
        ("/connections", "connections"),
        ("/connections/tools", "connection-tools"),
        ("/ssh", "ssh"),
        ("/database", "database"),
        ("/redis", "redis"),
        ("/active-connections", "active-connections"),
        ("/audit", "audit"),
        ("/organization", "organization"),
        ("/settings?section=appearance", "settings"),
    ]
    for path, label in bright_routes:
        page.goto(f"{BASE_URL}{path}")
        page.wait_for_load_state("networkidle")
        expect(page.locator(".app-content > *").first).to_be_visible()
        assert_no_dark_surfaces(page, label, errors)

    page.goto(f"{BASE_URL}/ssh")
    page.wait_for_load_state("networkidle")
    bright_backgrounds["ssh"] = page.locator(".terminal-workspace").evaluate("element => getComputedStyle(element).backgroundColor")
    bright_backgrounds["sshConnections"] = page.locator(".ssh-hosts").evaluate("element => getComputedStyle(element).backgroundColor")
    expect(page.locator(".ssh-command-history")).to_be_visible()
    assert_no_dark_surfaces(page, "ssh-command-history", errors)
    page.locator(".terminal-sftp-toggle").click()
    expect(page.locator(".sftp-drawer.is-open")).to_be_visible()
    assert_no_dark_surfaces(page, "sftp-drawer", errors)
    page.locator(".sftp-drawer-close").click()
    page.get_by_role("button", name="新建 SSH 连接").click()
    expect(page.locator(".connection-editor-dialog")).to_be_visible()
    page.locator(".login-script-editor__terminal").scroll_into_view_if_needed()
    assert_no_dark_surfaces(page, "ssh-connection-dialog", errors)
    page.get_by_role("button", name="取消", exact=True).click()
    screenshot(page, "12-ssh-bright")

    page.goto(f"{BASE_URL}/database")
    page.wait_for_load_state("networkidle")
    bright_backgrounds["database"] = page.locator(".sql-workspace").evaluate("element => getComputedStyle(element).backgroundColor")
    page.locator(".sql-side-actions button", has_text="历史").click()
    expect(page.locator(".query-side-panel")).to_be_visible()
    assert_no_dark_surfaces(page, "database-history", errors)
    screenshot(page, "13-database-bright")

    page.goto(f"{BASE_URL}/environments/{environment['id']}")
    page.wait_for_load_state("networkidle")
    page.locator(".workspace-tabs button", has_text="日志").click()
    expect(page.locator(".environment-log-panel")).to_be_visible()
    bright_backgrounds["logs"] = page.locator(".log-viewer").evaluate("element => getComputedStyle(element).backgroundColor")
    assert_no_dark_surfaces(page, "environment-logs", errors)
    page.get_by_role("button", name="新增日志", exact=True).click()
    expect(page.locator(".log-config-dialog")).to_be_visible()
    assert_no_dark_surfaces(page, "log-config-dialog", errors)
    page.get_by_role("button", name="取消", exact=True).click()
    screenshot(page, "14-logs-bright")
    for area, color in bright_backgrounds.items():
        channels = [int(value.strip()) for value in color.removeprefix("rgb(").removesuffix(")").split(",")[:3]]
        if min(channels) < 235:
            errors.append(f"bright theme {area} background is not light: {color}")

    public_context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    public_context.add_init_script("localStorage.setItem('envman-theme', 'bright')")
    public_page = public_context.new_page()
    public_page.goto(f"{BASE_URL}/login")
    public_page.wait_for_load_state("networkidle")
    expect(public_page.locator("html")).to_have_class("bright")
    expect(public_page.get_by_role("heading", name="登录 Viron")).to_be_visible()
    assert_no_dark_surfaces(public_page, "login", errors)
    public_page.set_viewport_size({"width": 1024, "height": 768})
    assert_no_dark_surfaces(public_page, "login-1024", errors)
    public_context.close()

    report = {
        "screenshots": str(OUTPUT),
        "layout": layout,
        "responsive": responsive_dimensions,
        "settingsVisuals": settings_visuals,
        "brightBackgrounds": bright_backgrounds,
        "errors": errors,
        "failedRequests": failed_requests,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    browser.close()
    if errors or failed_requests:
        raise SystemExit(1)
