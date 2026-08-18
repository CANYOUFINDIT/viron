import { describe, expect, it } from "vitest";
import { agentEntryMode } from "../src/shared/agent.js";

describe("AI Agent entry mode", () => {
  it("defaults an unset or invalid preference to disabled", () => {
    expect(agentEntryMode(undefined)).toBe("disabled");
    expect(agentEntryMode(null)).toBe("disabled");
    expect(agentEntryMode("unknown")).toBe("disabled");
  });

  it("keeps explicit and legacy floating preferences", () => {
    expect(agentEntryMode("floating")).toBe("floating");
    expect(agentEntryMode("both")).toBe("floating");
  });

  it("accepts the non-default entry modes", () => {
    expect(agentEntryMode("quick")).toBe("quick");
    expect(agentEntryMode("disabled")).toBe("disabled");
  });
});
