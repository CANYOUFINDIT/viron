import { describe, expect, it } from "vitest";
import {
  defaultMonitoredDiskTypes,
  monitorDiskIsEligible,
  monitorDiskType,
  stableMonitorDisks,
  visibleMonitorDisks,
} from "../src/shared/monitor-alerts.js";

describe("monitor disk policy", () => {
  it("classifies host, NFS, network, and container mounts", () => {
    expect(monitorDiskType({ path: "/", filesystem: "ext4" })).toBe("host_local");
    expect(monitorDiskType({ path: "/var/lib/docker", filesystem: "xfs" })).toBe("host_local");
    expect(monitorDiskType({ path: "/mnt/share", filesystem: "nfs4" })).toBe("nfs");
    expect(monitorDiskType({ path: "/mnt/legacy-share", device: "server:/volume" })).toBe("nfs");
    expect(monitorDiskType({ path: "/mnt/cifs", filesystem: "cifs", device: "//files/share" })).toBe("csi_network");
    expect(monitorDiskType({
      path: "/var/lib/kubelet/pods/id/volumes/kubernetes.io~nfs/vol",
      filesystem: "nfs",
      device: "192.168.5.195:/opt/onepro/hehao/vllm",
    })).toBe("container_pod");
    expect(monitorDiskType({
      path: "/var/lib/kubelet/pods/id/volumes/kubernetes.io~csi/pvc/mount",
      filesystem: "ext4",
      device: "/dev/sdz1",
    })).toBe("container_pod");
    expect(monitorDiskType({ path: "/proc", filesystem: "proc" })).toBe(null);
  });

  it("filters container, Kubernetes, virtual, and remote mounts by default", () => {
    expect(monitorDiskIsEligible({ path: "/", filesystem: "ext4" })).toBe(true);
    expect(monitorDiskIsEligible({ path: "/var/lib/docker", filesystem: "xfs" })).toBe(true);
    expect(monitorDiskIsEligible({ path: "/var/lib/docker/overlay2/id/merged", filesystem: "ext4" })).toBe(false);
    expect(monitorDiskIsEligible({ path: "/var/lib/kubelet/pods/id/volumes/data", filesystem: "xfs" })).toBe(false);
    expect(monitorDiskIsEligible({ path: "/mnt/share", filesystem: "nfs4" })).toBe(false);
    expect(monitorDiskIsEligible({ path: "/mnt/legacy-share", device: "server:/volume" })).toBe(false);
    expect(monitorDiskIsEligible({ path: "/proc", filesystem: "proc" })).toBe(false);
  });

  it("includes extra types when they are opted in", () => {
    const kubeNfs = {
      path: "/var/lib/kubelet/pods/id/volumes/kubernetes.io~nfs/vol",
      filesystem: "nfs",
      device: "192.168.5.195:/opt/onepro/hehao/vllm",
    };
    const kubeCsi = {
      path: "/var/lib/kubelet/pods/id/volumes/kubernetes.io~csi/pvc/mount",
      filesystem: "ext4",
      device: "/dev/sdz1",
    };
    const hostNfs = { path: "/mnt/share", filesystem: "nfs4", device: "nas:/export" };
    expect(monitorDiskIsEligible(kubeNfs, ["host_local"])).toBe(false);
    expect(monitorDiskIsEligible(kubeCsi, ["host_local"])).toBe(false);
    expect(monitorDiskIsEligible(hostNfs, ["host_local"])).toBe(false);
    expect(monitorDiskIsEligible(kubeNfs, ["host_local", "container_pod"])).toBe(true);
    expect(monitorDiskIsEligible(kubeCsi, ["host_local", "container_pod"])).toBe(true);
    expect(monitorDiskIsEligible(hostNfs, ["host_local", "nfs"])).toBe(true);
    expect(visibleMonitorDisks([kubeNfs, kubeCsi, hostNfs], {
      monitoredDiskTypes: defaultMonitoredDiskTypes,
      excludedDisks: [],
    })).toEqual([]);
    expect(visibleMonitorDisks([kubeNfs, kubeCsi, hostNfs], {
      monitoredDiskTypes: ["nfs", "container_pod"],
      excludedDisks: [],
    }).map((disk) => disk.path)).toEqual([
      "/mnt/share",
      "/var/lib/kubelet/pods/id/volumes/kubernetes.io~csi/pvc/mount",
      "/var/lib/kubelet/pods/id/volumes/kubernetes.io~nfs/vol",
    ]);
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
