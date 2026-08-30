import { describe, expect, it } from "vitest";
import { monitorDiskIsEligible, stableMonitorDisks } from "../src/shared/monitor-alerts.js";

describe("monitor disk policy", () => {
  it("filters container, Kubernetes, virtual, and remote mounts", () => {
    expect(monitorDiskIsEligible({ path: "/", filesystem: "ext4" })).toBe(true);
    expect(monitorDiskIsEligible({ path: "/var/lib/docker", filesystem: "xfs" })).toBe(true);
    expect(monitorDiskIsEligible({ path: "/var/lib/docker/overlay2/id/merged", filesystem: "ext4" })).toBe(false);
    expect(monitorDiskIsEligible({ path: "/var/lib/kubelet/pods/id/volumes/data", filesystem: "xfs" })).toBe(false);
    expect(monitorDiskIsEligible({ path: "/mnt/share", filesystem: "nfs4" })).toBe(false);
    expect(monitorDiskIsEligible({ path: "/mnt/legacy-share", device: "server:/volume" })).toBe(false);
    expect(monitorDiskIsEligible({ path: "/proc", filesystem: "proc" })).toBe(false);
  });

  it("deduplicates bind mounts that share the same device", () => {
    expect(stableMonitorDisks([
      { path: "/srv/app/data", device: "/dev/sda1", filesystem: "ext4" },
      { path: "/", device: "sda1", filesystem: "ext4" },
      { path: "/data", device: "/dev/sdb1", filesystem: "xfs" },
    ])).toEqual([
      { path: "/", device: "sda1", filesystem: "ext4" },
      { path: "/data", device: "/dev/sdb1", filesystem: "xfs" },
    ]);
  });
});
