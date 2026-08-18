import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRouteScrollPosition } from "../src/client/route-scroll.js";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

function routeLocation(name: string | undefined, path: string) {
  return { name, path } as Parameters<typeof resolveRouteScrollPosition>[0];
}

describe("environment workspace tab scroll", () => {
  it("keeps the current scroll when only the environment query changes", () => {
    const environment = routeLocation("environment", "/environments/dev");
    expect(resolveRouteScrollPosition(environment, environment, null)).toBe(false);
    expect(resolveRouteScrollPosition(
      routeLocation("environment", "/environments/other"),
      environment,
      null,
    )).toEqual({ top: 0, left: 0 });
    expect(resolveRouteScrollPosition(environment, routeLocation(undefined, "/"), null)).toEqual({ top: 0, left: 0 });
    expect(resolveRouteScrollPosition(environment, environment, { top: 240, left: 0 })).toEqual({ top: 240, left: 0 });
  });

  it("pins the workspace tabs after every tab click, including the first route sync", () => {
    const router = source("src/client/router.ts");
    const detail = source("src/client/views/EnvironmentDetailView.vue");
    expect(router).toContain("scrollBehavior: resolveRouteScrollPosition");
    expect(router).not.toContain("scrollBehavior: () => ({ top: 0, left: 0 })");
    expect(detail).toContain("activeTab.value = tab;");
    expect(detail).toContain('await router.replace({ name: "environment", params: { id: environmentId }, query })');
    expect(detail).toContain("requestAnimationFrame");
    expect(detail).toContain("pinWorkspaceTabsIntoView()");
    expect(detail).toContain('block: "start"');
  });
});
