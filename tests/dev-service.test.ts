import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

function serviceFixture(platform = "Darwin", submitStatus = "0") {
  const root = mkdtempSync(join(tmpdir(), "viron-dev-service-test-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  copyFileSync(new URL("../scripts/dev-service.sh", import.meta.url), join(root, "scripts", "dev-service.sh"));
  writeFileSync(join(root, ".env"), "HOST=127.0.0.1\nPORT=18080\nWEB_CLIENT_ENABLED=false\nDEV_SERVICE_HEALTH_TIMEOUT_SECONDS=invalid\n");

  const command = (name: string, body: string) => writeFileSync(join(root, "bin", name),
    `#!/bin/bash\nprintf '%s %s\\n' '${name}' "$*" >> "$DEV_SERVICE_TEST_ROOT/calls"\n${body}\n`, { mode: 0o755 });
  command("uname", 'printf "%s\\n" "$DEV_SERVICE_TEST_PLATFORM"');
  command("docker", "exit 99");
  command("curl", "exit 99");
  command("lsof", "echo fixture-listener");
  command("launchctl", `case "$1" in
  print) [[ -f "$DEV_SERVICE_TEST_ROOT/loaded" ]] || exit 1; echo '    pid = ${process.pid}';;
  submit) [[ "$DEV_SERVICE_TEST_SUBMIT_STATUS" == 0 ]] || exit "$DEV_SERVICE_TEST_SUBMIT_STATUS"; touch "$DEV_SERVICE_TEST_ROOT/loaded";;
  bootout) rm -f "$DEV_SERVICE_TEST_ROOT/loaded";;
esac`);
  command("node", 'printf "%s\\n%s\\n" "$PWD" "$TMPDIR" > "$DEV_SERVICE_TEST_ROOT/source-runtime"\nexec /bin/sleep 30');

  const run = (action: string) => execFileSync("bash", [join(root, "scripts", "dev-service.sh"), action], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      DEV_SERVICE_TEST_ROOT: root,
      DEV_SERVICE_TEST_PLATFORM: platform,
      DEV_SERVICE_TEST_SUBMIT_STATUS: submitStatus,
    },
  });
  const calls = () => readFileSync(join(root, "calls"), "utf8");
  return { root, run, calls };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const pidFile = join(root, ".tmp", "envman-dev.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 0 && pid !== process.pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* The fixture process already exited. */ }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local source development service", () => {
  it("submits local source on macOS without dependency, Docker, port, or HTTP preflights", () => {
    const fixture = serviceFixture();
    const output = fixture.run("start");

    expect(output).toContain(`launched with PID ${process.pid}`);
    expect(output).toContain("Frontend: disabled");
    expect(output).toContain("API: http://127.0.0.1:18080");
    expect(output).toContain("Source initialization continues in the background");
    expect(fixture.calls()).toContain("node scripts/dev.mjs");
    expect(fixture.calls()).not.toMatch(/^(docker|curl|lsof|node) /m);
  });

  it("launches local source with nohup on Linux before an API is listening", async () => {
    const fixture = serviceFixture("Linux");
    expect(fixture.run("start")).toContain("launched with PID");

    await expect.poll(() => existsSync(join(fixture.root, "source-runtime"))).toBe(true);
    expect(readFileSync(join(fixture.root, "source-runtime"), "utf8")).toBe(`${fixture.root}\n${join(fixture.root, ".tmp")}\n`);
    expect(fixture.calls()).toContain("node scripts/dev.mjs");
    expect(fixture.calls()).not.toMatch(/^(docker|curl|lsof) /m);
  });

  it("keeps repeated starts idempotent and reports process status without inspecting images", () => {
    const fixture = serviceFixture();
    fixture.run("start");
    expect(fixture.run("start")).toContain("already running");
    expect(fixture.run("status")).toContain(`Service PID: ${process.pid} (running)`);
    expect(fixture.calls().match(/^launchctl submit /gm)).toHaveLength(1);
    expect(fixture.calls()).not.toMatch(/^(docker|curl) /m);
  });

  it("still reports an operating-system launch failure", () => {
    const fixture = serviceFixture("Darwin", "42");
    expect(() => fixture.run("start")).toThrow();
    expect(existsSync(join(fixture.root, ".tmp", "envman-dev.pid"))).toBe(false);
  });
});
