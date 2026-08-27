import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("certificate center UI", () => {
  it("upgrades the global credentials entry and keeps SSH keys on a tab", () => {
    const shell = source("src/client/components/AppShell.vue");
    const view = source("src/client/views/SshKeysView.vue");
    expect(shell).toContain('label: tr("密钥与证书")');
    expect(shell).toContain('routeName: "ssh-keys"');
    expect(view).toContain('$t(\'密钥与证书\')');
    expect(view).toContain("selectTab('ssl')");
    expect(view).toContain("CertificateCenter");
  });

  it("shows web entry TLS popover with in-place probe and credentials jump", () => {
    const detail = source("src/client/views/EnvironmentDetailView.vue");
    const popover = source("src/client/components/credentials/TlsPopover.vue");
    expect(detail).toContain("TlsPopover");
    expect(popover).toContain("/api/v1/tls-endpoints/${props.tls.endpointId}/probe");
    expect(popover).toContain('tab: "ssl"');
    expect(popover).toContain("$t('立即重新探测')");
  });

  it("does not import the untracked monitoring dashboard", () => {
    const view = source("src/client/views/SshKeysView.vue");
    const detail = source("src/client/views/EnvironmentDetailView.vue");
    expect(view).not.toContain("EnvironmentMonitoringDashboard");
    expect(detail).not.toContain("EnvironmentMonitoringDashboard");
  });
});
