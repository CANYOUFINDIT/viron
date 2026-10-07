import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

function serviceFixture(options: {
  platform?: string;
  submitStatus?: string;
  webEnabled?: boolean;
  apiReadyAfter?: number;
  webReadyAfter?: number;
  timeout?: string;
  host?: string;
  exitEarly?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "viron-dev-service-test-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  copyFileSync(new URL("../scripts/dev-service.sh", import.meta.url), join(root, "scripts", "dev-service.sh"));
  writeFileSync(join(root, ".env"), `HOST=${options.host ?? "127.0.0.1"}\nPORT=18080\nWEB_CLIENT_ENABLED=${options.webEnabled ?? false}\nDEV_SERVICE_HEALTH_TIMEOUT_SECONDS=${options.timeout ?? "5"}\n`);
  writeFileSync(join(root, "api-ready-after"), String(options.apiReadyAfter ?? 1));
  writeFileSync(join(root, "web-ready-after"), String(options.webReadyAfter ?? 1));
  if (options.exitEarly) writeFileSync(join(root, "exit-early"), "");

  const command = (name: string, body: string) => writeFileSync(join(root, "bin", name),
    `#!/bin/bash\nprintf '%s %s\\n' '${name}' "$*" >> "$DEV_SERVICE_TEST_ROOT/calls"\n${body}\n`, { mode: 0o755 });
  command("uname", 'printf "%s\\n" "$DEV_SERVICE_TEST_PLATFORM"');
  command("docker", "exit 99");
  command("curl", `for url in "$@"; do :; done
case "$url" in
  */readyz) service=api;;
  *) service=web;;
esac
count=0
[[ ! -f "$DEV_SERVICE_TEST_ROOT/$service-probes" ]] || count="$(cat "$DEV_SERVICE_TEST_ROOT/$service-probes")"
count=$((count + 1))
printf '%s\\n' "$count" > "$DEV_SERVICE_TEST_ROOT/$service-probes"
if [[ "$count" -ge "$(cat "$DEV_SERVICE_TEST_ROOT/$service-ready-after")" ]]; then
  printf '200'
else
  printf '503'
fi`);
  command("lsof", `[[ -f "$DEV_SERVICE_TEST_ROOT/runtime.pid" ]] || exit 1
pid="$(cat "$DEV_SERVICE_TEST_ROOT/runtime.pid")"
kill -0 "$pid" 2>/dev/null || exit 1
case "$*" in
  *'-d cwd'*)
    if [[ -f "$DEV_SERVICE_TEST_ROOT/unrelated-listener" ]]; then
      echo n/unrelated-project
    else
      echo "n$DEV_SERVICE_TEST_ROOT"
    fi;;
  *'-tiTCP:'*) echo "$pid";;
  *'-iTCP:'*) echo fixture-listener;;
  *) exit 1;;
esac`);
  command("launchctl", `case "$1" in
  print) [[ -f "$DEV_SERVICE_TEST_ROOT/loaded" ]] || exit 1; echo "    pid = $(cat "$DEV_SERVICE_TEST_ROOT/runtime.pid")";;
  submit)
    [[ "$DEV_SERVICE_TEST_SUBMIT_STATUS" == 0 ]] || exit "$DEV_SERVICE_TEST_SUBMIT_STATUS"
    nohup env TMPDIR="$DEV_SERVICE_TEST_ROOT/.tmp" node scripts/dev.mjs > "$DEV_SERVICE_TEST_ROOT/.tmp/envman-dev.log" 2>&1 </dev/null &
    echo "$!" > "$DEV_SERVICE_TEST_ROOT/runtime.pid"
    touch "$DEV_SERVICE_TEST_ROOT/loaded";;
  bootout)
    kill "$(cat "$DEV_SERVICE_TEST_ROOT/runtime.pid")" 2>/dev/null || true
    rm -f "$DEV_SERVICE_TEST_ROOT/loaded";;
esac`);
  command("node", `printf '%s\\n' "$$" > "$DEV_SERVICE_TEST_ROOT/runtime.pid"
printf '%s\\n%s\\n' "$PWD" "$TMPDIR" > "$DEV_SERVICE_TEST_ROOT/source-runtime"
echo 'fixture initializing'
if [[ -f "$DEV_SERVICE_TEST_ROOT/exit-early" ]]; then
  echo 'fixture startup failed'
  exit 43
fi
exec /bin/sleep 30`);

  const runOptions = {
    cwd: root,
    encoding: "utf8" as const,
    timeout: 8_000,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      DEV_SERVICE_TEST_ROOT: root,
      DEV_SERVICE_TEST_PLATFORM: options.platform ?? "Darwin",
      DEV_SERVICE_TEST_SUBMIT_STATUS: options.submitStatus ?? "0",
      DEV_SERVICE_HEALTH_TIMEOUT_SECONDS: "",
    },
  };
  const run = (action: string) => execFileSync("bash", [join(root, "scripts", "dev-service.sh"), action], runOptions);
  const result = (action: string) => spawnSync("bash", [join(root, "scripts", "dev-service.sh"), action], runOptions);
  const calls = () => readFileSync(join(root, "calls"), "utf8");
  return { root, run, result, calls };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    for (const pidFile of [join(root, "runtime.pid"), join(root, ".tmp", "envman-dev.pid")]) {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (pid > 0 && pid !== process.pid) {
          try { process.kill(pid, "SIGTERM"); } catch { /* The fixture process already exited. */ }
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local source development service", () => {
  it("submits local source on macOS and waits for API readiness with the frontend disabled", () => {
    const fixture = serviceFixture();
    const output = fixture.run("start");

    expect(output).toContain("launched with PID");
    expect(output).toContain("Frontend: disabled");
    expect(output).toContain("API: http://127.0.0.1:18080");
    expect(output).toContain("API ready: http://127.0.0.1:18080");
    expect(output).toContain("Viron dev service is ready.");
    expect(fixture.calls()).toContain("node scripts/dev.mjs");
    expect(fixture.calls()).toContain("http://127.0.0.1:18080/readyz");
    expect(fixture.calls()).not.toContain("http://127.0.0.1:5173/");
    expect(fixture.calls()).not.toMatch(/^docker /m);
  });

  it("launches local source with nohup on Linux and waits through API initialization", () => {
    const fixture = serviceFixture({ platform: "Linux", apiReadyAfter: 2 });
    const output = fixture.run("start");
    expect(output).toContain("Waiting for API...");
    expect(output).toContain("Viron dev service is ready.");

    expect(readFileSync(join(fixture.root, "source-runtime"), "utf8")).toBe(`${fixture.root}\n${join(fixture.root, ".tmp")}\n`);
    expect(fixture.calls()).toContain("node scripts/dev.mjs");
    expect(Number(readFileSync(join(fixture.root, "api-probes"), "utf8"))).toBeGreaterThanOrEqual(2);
    expect(fixture.calls()).not.toMatch(/^docker /m);
  });

  it.each([[2, 3], [3, 2]])("waits for both services when API needs %i probes and frontend needs %i", (apiReadyAfter, webReadyAfter) => {
    const fixture = serviceFixture({ webEnabled: true, apiReadyAfter, webReadyAfter });
    const output = fixture.run("start");

    expect(output).toContain("API ready: http://127.0.0.1:18080");
    expect(output).toContain("Frontend ready: http://127.0.0.1:5173/");
    expect(output.trim().endsWith("Viron dev service is ready.")).toBe(true);
    expect(Number(readFileSync(join(fixture.root, "api-probes"), "utf8"))).toBeGreaterThanOrEqual(apiReadyAfter);
    expect(Number(readFileSync(join(fixture.root, "web-probes"), "utf8"))).toBeGreaterThanOrEqual(webReadyAfter);
    expect(fixture.calls().indexOf("launchctl submit")).toBeLessThan(fixture.calls().indexOf("curl "));
  });

  it("keeps repeated starts idempotent and waits for the existing services to be ready", () => {
    const fixture = serviceFixture();
    fixture.run("start");
    const output = fixture.run("start");
    expect(output).toContain("already running");
    expect(output).toContain("Viron dev service is ready.");
    expect(fixture.run("status")).toMatch(/Service PID: \d+ \(running\)/);
    expect(fixture.calls().match(/^launchctl submit /gm)).toHaveLength(1);
    expect(fixture.calls().match(/^curl /gm)).toHaveLength(2);
    expect(fixture.calls()).not.toMatch(/^docker /m);
  });

  it("does not report an existing but unready service as successfully started", () => {
    const fixture = serviceFixture({ timeout: "1" });
    fixture.run("start");
    writeFileSync(join(fixture.root, "api-ready-after"), "999");
    const result = fixture.result("start");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("already running");
    expect(result.stdout).toContain("Timed out after 1s waiting for API");
    expect(fixture.calls().match(/^launchctl submit /gm)).toHaveLength(1);
  });

  it("fails with diagnostics when only the API becomes ready and leaves the background service running", () => {
    const fixture = serviceFixture({ webEnabled: true, webReadyAfter: 999, timeout: "1" });
    const result = fixture.result("start");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("API ready:");
    expect(result.stdout).not.toContain("Frontend ready:");
    expect(result.stdout).toContain("Timed out after 1s waiting for frontend");
    expect(result.stdout).toContain("fixture initializing");
    expect(result.stdout).not.toContain("Viron dev service is ready.");
    expect(() => process.kill(Number(readFileSync(join(fixture.root, "runtime.pid"), "utf8")), 0)).not.toThrow();
  });

  it("does not accept a listening service belonging to another project", () => {
    const fixture = serviceFixture({ timeout: "1" });
    writeFileSync(join(fixture.root, "unrelated-listener"), "");
    const result = fixture.result("start");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Timed out after 1s waiting for API");
    expect(fixture.calls()).not.toMatch(/^curl /m);
  });

  it.each(["0.0.0.0", "::"])("probes a loopback address for wildcard host %s", (host) => {
    const fixture = serviceFixture({ host });
    const output = fixture.run("start");
    const url = host === "::" ? "http://[::1]:18080" : "http://127.0.0.1:18080";
    expect(output).toContain(`API ready: ${url}`);
    expect(fixture.calls()).toContain(`${url}/readyz`);
    expect(fixture.calls()).toContain("--noproxy * --connect-timeout 1 --max-time 1");
  });

  it("fails promptly and prints recent logs when the startup process exits", () => {
    const fixture = serviceFixture({ exitEarly: true, apiReadyAfter: 999 });
    const result = fixture.result("start");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("exited before becoming ready");
    expect(result.stdout).toContain("fixture startup failed");
    expect(result.stdout).not.toContain("Timed out");
  });

  it.each(["stop", "down"])("stops the service using %s", (action) => {
    const fixture = serviceFixture();
    fixture.run("start");
    expect(fixture.run(action)).toContain("Viron dev service stopped.");
    expect(fixture.calls()).toContain("launchctl bootout");
    expect(existsSync(join(fixture.root, ".tmp", "envman-dev.pid"))).toBe(false);
    expect(existsSync(join(fixture.root, "loaded"))).toBe(false);
  });

  it("waits for readiness after a restart", () => {
    const fixture = serviceFixture({ webEnabled: true });
    fixture.run("start");
    const previousPid = readFileSync(join(fixture.root, "runtime.pid"), "utf8");
    const output = fixture.run("restart");

    expect(output).toContain("Viron dev service stopped.");
    expect(output).toContain("API ready:");
    expect(output).toContain("Frontend ready:");
    expect(output).toContain("Viron dev service is ready.");
    expect(readFileSync(join(fixture.root, "runtime.pid"), "utf8")).not.toBe(previousPid);
    expect(fixture.calls().match(/^launchctl submit /gm)).toHaveLength(2);
  });

  it("rejects an invalid readiness timeout before launching", () => {
    const fixture = serviceFixture({ timeout: "invalid" });
    const result = fixture.result("start");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must be a positive integer");
    expect(existsSync(join(fixture.root, ".tmp", "envman-dev.pid"))).toBe(false);
    expect(existsSync(join(fixture.root, "calls"))).toBe(false);
  });

  it("still reports an operating-system launch failure", () => {
    const fixture = serviceFixture({ submitStatus: "42" });
    expect(() => fixture.run("start")).toThrow();
    expect(existsSync(join(fixture.root, ".tmp", "envman-dev.pid"))).toBe(false);
  });
});
