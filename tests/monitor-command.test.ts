import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restartMonitorServiceCommand } from "../src/server/monitor-installer.js";
import { monitorCommand, monitorCommandNotFound, monitorPathSetupCommand } from "../src/server/monitor-command.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function shellFixture() {
  const directory = mkdtempSync(join(tmpdir(), "viron-monitor-command-"));
  directories.push(directory);
  const bin = join(directory, "ssh-bin");
  const localBin = join(directory, "usr/local/bin");
  const installDir = join(directory, "opt/viron/monitor");
  const environmentFile = join(directory, "viron-monitor.env");
  for (const path of [bin, localBin, installDir]) mkdirSync(path, { recursive: true });
  const executable = (path: string, body: string) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  executable(join(bin, "id"), "printf '0\\n'");
  executable(join(bin, "systemctl"), 'printf "systemctl %s %s\\n" "$1" "$2"');
  const run = (command: string) => spawnSync("/bin/sh", ["-c", command
    .replaceAll("/usr/local/bin", localBin)
    .replaceAll("/opt/viron/monitor", installDir)
    .replaceAll("/etc/viron-monitor/viron-monitor.env", environmentFile)], {
    encoding: "utf8",
    env: { PATH: bin },
  });
  return { directory, bin, localBin, installDir, environmentFile, executable, run };
}

describe.skipIf(process.platform === "win32")("monitor commands over non-interactive SSH", () => {
  it("finds the managed installation when SSH PATH excludes /usr/local/bin", () => {
    const fixture = shellFixture();
    fixture.executable(join(fixture.installDir, "viron-monitor"), "exit 0");
    symlinkSync(join(fixture.installDir, "viron-monitor"), join(fixture.localBin, "viron-monitor"));

    const result = fixture.run(restartMonitorServiceCommand());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("systemctl restart viron-monitor\n");
  });

  it("collects and pulls through the stable entry point of a custom installation", () => {
    const fixture = shellFixture();
    const customPath = join(fixture.directory, "custom-monitor");
    fixture.executable(customPath, 'printf "%s:%s:%s\\n" "$1" "$2" "$VIRON_MONITOR_DATA_DIR"');
    symlinkSync(customPath, join(fixture.localBin, "viron-monitor"));
    writeFileSync(fixture.environmentFile, "VIRON_MONITOR_DATA_DIR=/custom-monitor-data\n");

    const result = fixture.run(monitorCommand("viron-monitor collect --quiet && viron-monitor pull --after 0 --limit 20"));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("collect:--quiet:/custom-monitor-data\npull:--after:/custom-monitor-data\n");
  });

  it("finds the default binary even if its stable symlink is missing", () => {
    const fixture = shellFixture();
    fixture.executable(join(fixture.installDir, "viron-monitor"), "printf 'pulled\\n'");

    const result = fixture.run(monitorCommand("viron-monitor pull --after 0 --limit 20"));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("pulled\n");
  });

  it("keeps manually installed probes on the existing SSH PATH discoverable", () => {
    const fixture = shellFixture();
    fixture.executable(join(fixture.bin, "viron-monitor"), "printf 'legacy\\n'");

    const result = fixture.run(monitorCommand("viron-monitor pull --after 0 --limit 20"));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("legacy\n");
  });

  it("distinguishes missing probes from installed executables exiting 127", () => {
    const fixture = shellFixture();
    const missing = fixture.run(monitorCommand("viron-monitor pull"));
    expect(monitorCommandNotFound({ exitCode: missing.status, stderr: missing.stderr })).toBe(true);

    fixture.executable(join(fixture.localBin, "viron-monitor"), "printf 'loader failed\\n' >&2; exit 127");
    const failed = fixture.run(monitorCommand("viron-monitor pull"));

    expect(failed.status).toBe(127);
    expect(failed.stderr).toBe("loader failed\n");
    expect(monitorCommandNotFound({ exitCode: failed.status, stderr: failed.stderr })).toBe(false);
  });

  it("supports preflight discovery with an unset PATH under set -u", () => {
    const fixture = shellFixture();
    fixture.executable(join(fixture.localBin, "viron-monitor"), "exit 0");

    const result = fixture.run(`unset PATH; set -u; ${monitorPathSetupCommand}; command -v viron-monitor`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(join(fixture.localBin, "viron-monitor"));
  });
});
