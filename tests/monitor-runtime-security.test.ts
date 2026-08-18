import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("monitor runtime security", () => {
  it("runs collection as root behind a group-restricted local socket", () => {
    for (const path of ["monitor/viron-monitor.service", "monitor/viron-monitor.service.legacy"]) {
      const unit = source(path);
      expect(unit).toMatch(/^User=root$/m);
      expect(unit).toMatch(/^Group=viron-monitor$/m);
      expect(unit).toMatch(/^RuntimeDirectory=viron-monitor$/m);
      expect(unit).toMatch(/^ProtectHome=read-only$/m);
      expect(unit).toContain("/run/viron-monitor");
    }

    const installer = source("monitor/install.sh");
    expect(installer).toContain("VIRON_MONITOR_CONTROL_SOCKET=/run/viron-monitor/control.sock");
    expect(installer).toContain("install -d -m 2770 -o root -g viron-monitor /var/lib/viron-monitor");
    expect(installer).not.toMatch(/usermod .*-[a-zA-Z]*G (docker|podman) viron-monitor/);
  });
});
