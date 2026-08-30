import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("app shell navigation", () => {
  const shell = source("src/client/components/AppShell.vue");

  it("opens the monitoring dashboard as the default home route", () => {
    const router = source("src/client/router.ts");
    const login = source("src/client/views/LoginView.vue");
    expect(router).toContain('{ path: "/", redirect: { name: "monitoring" } }');
    expect(router).toContain('{ path: "/overview", name: "overview"');
    expect(router).toContain('if (to.name === "login" && session.user) return { name: "monitoring" };');
    expect(login).toContain('{ name: "monitoring" }');
    expect(shell).toContain('await router.replace({ name: "monitoring" });');
  });

  it("keeps monitoring first, knowledge above audit, and the sidebar toggle above client downloads", () => {
    expect(shell).toContain('{ key: "monitoring"');
    expect(shell.indexOf('{ key: "monitoring"')).toBeLessThan(shell.indexOf('{ key: "overview"'));
    expect(shell.indexOf('{ key: "knowledge"')).toBeLessThan(shell.indexOf('{ key: "audit"'));
    expect(shell.indexOf('class="header-icon-action sidebar-toggle"')).toBeLessThan(shell.indexOf("route.name === 'client-downloads'"));
  });

  it("collapses the shared sidebar when entering or switching environment details", () => {
    expect(shell).toContain('const activeEnvironmentId = computed(() => route.name === "environment" ? String(route.params.id ?? "") : null);');
    expect(shell).toContain(`watch(
  activeEnvironmentId,
  (environmentId) => {
    if (environmentId !== null) unpinSidebar();
  },
  { immediate: true },
);`);
  });

  it("expands the collapsed sidebar on hover and collapses it on leave", () => {
    expect(shell).toContain("const sidebarPinned = ref(!window.matchMedia(\"(max-width: 900px)\").matches);");
    expect(shell).toContain("const sidebarHoverOpen = ref(false);");
    expect(shell).toContain("const sidebarExpanded = computed(() => sidebarPinned.value || sidebarHoverOpen.value);");
    expect(shell).toContain("function onSidebarPointerEnter()");
    expect(shell).toContain("function onSidebarPointerLeave(event: PointerEvent)");
    expect(shell).toContain("sidebarHoverOpen.value = true;");
    expect(shell).toContain("sidebarHoverOpen.value = false;");
    expect(shell).toContain("@pointerenter=\"onSidebarPointerEnter\"");
    expect(shell).toContain("@pointerleave=\"onSidebarPointerLeave\"");
    expect(shell).not.toContain("SIDEBAR_HOVER_EXPAND_MS");
    expect(shell).not.toContain("function onWorkspaceSwitcherClick");
    expect(shell).toContain('placement="right-start"');
    expect(shell).toContain(':popper-options="workspaceSwitcherPopperOptions"');
    expect(shell).toContain('{ name: "flip", enabled: false }');
    expect(shell).toContain(':disabled="workspaceSwitching"');
  });

  it("uses the environment overview return context for the shared overview entry", () => {
    expect(shell).toContain("rememberedEnvironmentId.value = updateRememberedEnvironmentId(");
    expect(shell).toContain("environmentOverviewNavigationTarget(activeRouteName.value, rememberedEnvironmentId.value)");
    expect(shell).toContain('if (route.name !== target.name || Object.keys(route.query).length) await router.push(target);');
  });

  it("installs trackpad history navigation for previous and next visited pages", () => {
    expect(shell).toContain("installVisitHistory(router)");
    expect(shell).toContain("installHistoryNavigationGestures({");
    expect(shell).toContain("canNavigate: visitHistoryCanNavigate");
    expect(shell).toContain("navigate: visitHistoryNavigate");
    expect(shell).toContain("<HistoryNavigationOverlay />");
  });
});
