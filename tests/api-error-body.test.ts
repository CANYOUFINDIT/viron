import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import { readApiErrorBody } from "../src/client/api-error";
import { approvalFlowGroups, featuresForTargets } from "../src/client/views/organization/grant-selection";

describe("api error groups", () => {
  it("keeps the 409 group payload for browser and desktop callers", () => {
    const raw = JSON.stringify({
      error: "MULTIPLE_APPROVAL_FLOWS",
      message: "请按分组分别提交",
      groups: [{ flowId: "flow-a", flowName: "连接甲", targets: [{ type: "ssh_connection", id: "ssh-1" }] }],
    });
    const parsed = readApiErrorBody(raw);
    expect(parsed.code).toBe("MULTIPLE_APPROVAL_FLOWS");
    expect(parsed.details.groups).toEqual([{ flowId: "flow-a", flowName: "连接甲", targets: [{ type: "ssh_connection", id: "ssh-1" }] }]);
    const error = new ApiError(parsed.message ?? "", 409, parsed.code, undefined, parsed.details);
    expect(approvalFlowGroups(error)?.[0].targets).toEqual([{ type: "ssh_connection", id: "ssh-1" }]);
    expect(approvalFlowGroups(new ApiError("稍后", 429, "RATE_LIMIT", 1000, {}))).toBeNull();
  });

  it("sends web plugins only with an environment and keeps other flags", () => {
    const selected = { mcp: true, agent: false, webPlugins: true };
    expect(featuresForTargets(selected, [{ type: "environment" }])).toEqual(selected);
    expect(featuresForTargets(selected, [{ type: "ssh_connection" }])).toEqual({ mcp: true, agent: false, webPlugins: false });
    expect(featuresForTargets({ mcp: false, agent: false, webPlugins: true }, [{ type: "ssh_connection" }])).toEqual({ mcp: false, agent: false, webPlugins: false });
  });
});
