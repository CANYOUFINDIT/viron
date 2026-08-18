import { describe, expect, it } from "vitest";
import { normalizeMaintenanceScriptActions } from "../src/client/service-maintenance-payload";

describe("service maintenance payload compatibility", () => {
  it("normalizes legacy responses without script action collections", () => {
    const payload = normalizeMaintenanceScriptActions({
      services: [{ id: "service-1", deployments: [{ id: "deployment-1" }] }],
      logs: [],
      hosts: [],
    });

    expect(payload.scriptActionsSupported).toBe(false);
    expect(payload.services[0]?.scriptActions).toEqual([]);
    expect(payload.services[0]?.deployments[0]?.scriptActions).toEqual([]);
  });

  it("preserves current script actions and detects server support", () => {
    const serviceAction = { id: "service-action" };
    const deploymentAction = { id: "deployment-action" };
    const payload = normalizeMaintenanceScriptActions({
      services: [{
        id: "service-1",
        scriptActions: [serviceAction],
        deployments: [{ id: "deployment-1", scriptActions: [deploymentAction] }],
      }],
    });

    expect(payload.scriptActionsSupported).toBe(true);
    expect(payload.services[0]?.scriptActions).toEqual([serviceAction]);
    expect(payload.services[0]?.deployments[0]?.scriptActions).toEqual([deploymentAction]);
  });
});
