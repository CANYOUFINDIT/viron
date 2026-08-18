import { describe, expect, it } from "vitest";
import { resolveExecutionTargets } from "../src/shared/execution-mode";

const capabilities = {
  desktopLocal: { web: true, ssh: true, sftp: true, logs: true, database: true, redis: true, inspection: true },
  serverForwarding: { enabled: true, web: false, ssh: true, sftp: true, logs: true, database: true, redis: true },
};

describe("desktop execution mode", () => {
  it("uses the Mac for every supported capability by default", () => {
    expect(resolveExecutionTargets("local", capabilities)).toEqual({
      web: "local",
      ssh: "local",
      sftp: "local",
      logs: "local",
      database: "local",
      redis: "local",
      inspectionSsh: "local",
      inspectionDatabase: "local",
      inspectionRedis: "local",
    });
  });

  it("keeps Web local when the server cannot proxy it", () => {
    expect(resolveExecutionTargets("server", capabilities)).toMatchObject({
      web: "local",
      ssh: "server",
      sftp: "server",
      logs: "server",
      database: "server",
      redis: "server",
    });
  });

  it("does not silently fall back for unavailable SSH or database forwarding", () => {
    const targets = resolveExecutionTargets("server", {
      ...capabilities,
      serverForwarding: { enabled: true, web: true, ssh: false, sftp: false, logs: false, database: false, redis: false },
    });
    expect(targets).toMatchObject({
      web: "server",
      ssh: "unavailable",
      sftp: "unavailable",
      logs: "unavailable",
      database: "unavailable",
      redis: "unavailable",
      inspectionSsh: "unavailable",
      inspectionDatabase: "unavailable",
      inspectionRedis: "unavailable",
    });
  });
});
