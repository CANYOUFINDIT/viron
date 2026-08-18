import { describe, expect, it } from "vitest";
import { sshCommandRiskLevel } from "../src/shared/ssh-command-risk.js";

describe("SSH command risk", () => {
  it.each([
    "tail -n 500 -- /var/log/myapp/error.log",
    "journalctl -u viron --since '10 minutes ago' | tail -n 200",
    "systemctl status viron",
    "kubectl get pods -n apps",
    "kubectl logs -n apps pod/viron --tail=500",
    "find /var/log -type f -name '*.log' | head -n 20",
    "awk '{print $1}' /var/log/viron.log | sort | uniq -c",
    "curl -fsS https://example.test/healthz",
    "grep -R 'timeout' /var/log/viron 2>/dev/null",
    "pod=$(kubectl get pods -n apps --field-selector=status.phase=Running -o name | grep '^pod/myapp-' | head -n1); test -n \"$pod\" && kubectl exec -n apps \"$pod\" -- tail -n 500 -- /var/log/myapp/error.log",
  ])("does not require approval for a proven query: %s", (command) => {
    expect(sshCommandRiskLevel(command)).toBe("low");
  });

  it.each([
    "rm -rf /tmp/viron-cache",
    "tail -n 500 /var/log/viron.log > /tmp/copy.log",
    "find /tmp -type f -delete",
    "kubectl delete pod viron-0 -n apps",
    "kubectl config set-context production --namespace=default",
    "kubectl auth reconcile -f role.yaml",
    "kubectl exec -n apps pod/viron -- rm -f /tmp/lock",
    "ip netns exec production rm -f /tmp/lock",
    "printf '%s' \"$(rm -f /tmp/lock)\"",
    "sed -i 's/old/new/' /etc/viron.conf",
    "curl -X POST https://example.test/reload",
    "wget -O - --post-data='reload=1' https://example.test/admin",
    "tar --list --checkpoint-action=exec='rm -f /tmp/lock' -f backup.tar",
    "python3 -c 'from pathlib import Path; Path(\"/tmp/changed\").touch()'",
  ])("keeps state-changing or unclassified commands behind approval: %s", (command) => {
    expect(sshCommandRiskLevel(command)).toBe("high");
  });
});
