import type { SshCommandResult } from "./ssh/command.js";

export const MONITOR_NOT_FOUND_MARKER = "VIRON_MONITOR_NOT_FOUND";

// SSH exec sessions do not necessarily load login profiles. Include the stable
// installer entry point (also used for custom installs) and the default directory.
export const monitorPathSetupCommand = 'PATH="${PATH:+$PATH:}/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:/opt/viron/monitor"; export PATH';

export function monitorCommand(command: string): string {
  return [
    monitorPathSetupCommand,
    `command -v viron-monitor >/dev/null 2>&1 || { printf '%s\\n' '${MONITOR_NOT_FOUND_MARKER}' >&2; exit 127; }`,
    "set -a; if [ -r /etc/viron-monitor/viron-monitor.env ]; then . /etc/viron-monitor/viron-monitor.env; fi; set +a",
    command,
  ].join("; ");
}

export function monitorCommandNotFound(result: Pick<SshCommandResult, "exitCode" | "stderr">): boolean {
  // An installed executable (or one of its dependencies) can also exit 127.
  return result.exitCode === 127 && result.stderr.split(/\r?\n/).includes(MONITOR_NOT_FOUND_MARKER);
}
