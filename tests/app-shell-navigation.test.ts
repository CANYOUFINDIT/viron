import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("app shell navigation", () => {
  const shell = source("src/client/components/AppShell.vue");

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
    if (environmentId !== null) sidebarExpanded.value = false;
  },
  { immediate: true },
);`);
  });

  it("expands the shared sidebar before opening the workspace switcher", () => {
    expect(shell).toContain(`function expandSidebar() {
  sidebarExpanded.value = true;
}`);
    expect(shell).toContain("function onWorkspaceSwitcherClick(event: MouseEvent)");
    expect(shell).toContain("function openWorkspaceMenuAfterExpand()");
    expect(shell).toContain("const wait = waitForSidebarExpand();");
    expect(shell).toContain("expandSidebar();");
    expect(shell).toContain("workspaceSwitcherDropdown.value?.handleOpen()");
    expect(shell).toContain("if (workspaceMenuPending.value) return;");
    expect(shell).toContain("event.stopImmediatePropagation()");
    expect(shell).toContain('@click="onWorkspaceSwitcherClick"');
    expect(shell).toContain('@keydown="onWorkspaceSwitcherKeydown"');
    expect(shell).toContain('trigger="click"');
    expect(shell).toContain('placement="right-start"');
    expect(shell).toContain(':popper-options="workspaceSwitcherPopperOptions"');
    expect(shell).toContain('{ name: "flip", enabled: false }');
    expect(shell).toContain(':disabled="workspaceSwitching || !sidebarExpanded"');
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
