import { describe, expect, it } from "vitest";
import { activeApiKeys } from "../src/client/api-key-list";

describe("API key settings", () => {
  it("does not display revoked keys", () => {
    const active = { id: "active", status: "active" as const };
    const revoked = { id: "revoked", status: "revoked" as const };

    expect(activeApiKeys([revoked, active])).toEqual([active]);
  });
});
