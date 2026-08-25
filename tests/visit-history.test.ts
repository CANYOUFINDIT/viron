import { describe, expect, it } from "vitest";
import {
  applyVisitHistoryNavigation,
  emptyVisitHistory,
  recordVisitLocation,
  visitHistoryCanMove,
  visitLocationFromRoute,
  visitLocationKey,
  visitRouteTarget,
  type VisitLocation,
} from "../src/shared/visit-history.js";

function location(name: string, params: Record<string, string> = {}, query: Record<string, string> = {}): VisitLocation {
  return { name, params, query };
}

describe("visit history", () => {
  it("treats environment tabs as distinct visited views and defaults missing tab to web", () => {
    expect(visitLocationFromRoute({
      name: "environment",
      params: { id: "env-1" },
      query: {},
    })).toEqual(location("environment", { id: "env-1" }, { tab: "web" }));
    expect(visitLocationFromRoute({
      name: "environment",
      params: { id: "env-1" },
      query: { tab: "ssh", connectionId: "ssh-1", immersive: "1" },
    })).toEqual(location("environment", { id: "env-1" }, { tab: "ssh" }));
    expect(visitLocationKey(location("environment", { id: "env-1" }, { tab: "web" })))
      .not.toBe(visitLocationKey(location("environment", { id: "env-1" }, { tab: "ssh" })));
  });

  it("walks back through environment tabs before returning to the environment list", () => {
    let state = emptyVisitHistory();
    state = recordVisitLocation(state, location("overview"));
    state = recordVisitLocation(state, location("environment", { id: "env-1" }, { tab: "web" }));
    state = recordVisitLocation(state, location("environment", { id: "env-1" }, { tab: "ssh" }));

    expect(visitHistoryCanMove(state, "back")).toBe(true);
    expect(visitHistoryCanMove(state, "forward")).toBe(false);

    const toWeb = applyVisitHistoryNavigation(state, "back");
    expect(toWeb?.location).toEqual(location("environment", { id: "env-1" }, { tab: "web" }));
    const toOverview = applyVisitHistoryNavigation(toWeb!.state, "back");
    expect(toOverview?.location).toEqual(location("overview"));
    expect(visitHistoryCanMove(toOverview!.state, "back")).toBe(false);

    const forward = applyVisitHistoryNavigation(toOverview!.state, "forward");
    expect(forward?.location).toEqual(location("environment", { id: "env-1" }, { tab: "web" }));
  });

  it("does not record the same view twice, and truncates forward entries after a new branch", () => {
    let state = emptyVisitHistory();
    state = recordVisitLocation(state, location("overview"));
    state = recordVisitLocation(state, location("overview"));
    expect(state.entries).toHaveLength(1);
    state = recordVisitLocation(state, location("environment", { id: "env-1" }, { tab: "web" }));
    state = recordVisitLocation(state, location("environment", { id: "env-1" }, { tab: "ssh" }));
    state = applyVisitHistoryNavigation(state, "back")!.state;
    state = recordVisitLocation(state, location("environment", { id: "env-1" }, { tab: "database" }));
    expect(state.entries.map((entry) => entry.query.tab ?? entry.name)).toEqual(["overview", "web", "database"]);
    expect(visitHistoryCanMove(state, "forward")).toBe(false);
  });

  it("keeps immersive flags when switching tabs inside the same environment", () => {
    expect(visitRouteTarget(
      location("environment", { id: "env-1" }, { tab: "web" }),
      { name: "environment", params: { id: "env-1" }, query: { tab: "ssh", immersive: "1", webEntryId: "entry-1" } },
    )).toEqual({
      name: "environment",
      params: { id: "env-1" },
      query: { immersive: "1", webEntryId: "entry-1", tab: "web" },
    });
    expect(visitRouteTarget(
      location("overview"),
      { name: "environment", params: { id: "env-1" }, query: { tab: "ssh", immersive: "1" } },
    )).toEqual({ name: "overview", params: {}, query: {} });
  });
});
