package main

import "testing"

func TestMonitorDiskEligibleFiltersDynamicAndRemoteMounts(t *testing.T) {
	tests := []struct {
		path       string
		filesystem string
		want       bool
	}{
		{path: "/", filesystem: "ext4", want: true},
		{path: "/data", filesystem: "xfs", want: true},
		{path: "/var/lib/docker", filesystem: "xfs", want: true},
		{path: "/var/lib/docker/overlay2/abc/merged", filesystem: "ext4", want: false},
		{path: "/var/lib/kubelet/pods/uid/volumes/data", filesystem: "xfs", want: false},
		{path: "/mnt/share", filesystem: "nfs4", want: false},
		{path: "/proc", filesystem: "proc", want: false},
	}
	for _, test := range tests {
		if got := monitorDiskEligible(test.path, test.filesystem, ""); got != test.want {
			t.Fatalf("monitorDiskEligible(%q, %q) = %v, want %v", test.path, test.filesystem, got, test.want)
		}
	}
	if monitorDiskEligible("/mnt/legacy-share", "", "server:/volume") {
		t.Fatal("expected a remote device identity to be ignored even without a filesystem tag")
	}
}

func TestStableMonitorDisksDeduplicatesBindMountsByDevice(t *testing.T) {
	disks := stableMonitorDisks([]DiskSnapshot{
		{Path: "/srv/app/data", Device: "sda1", Filesystem: "ext4"},
		{Path: "/", Device: "sda1", Filesystem: "ext4"},
		{Path: "/data", Device: "sdb1", Filesystem: "xfs"},
	})
	if len(disks) != 2 {
		t.Fatalf("expected 2 stable disks, got %d", len(disks))
	}
	if disks[0].Path != "/" || disks[1].Path != "/data" {
		t.Fatalf("unexpected stable disks: %#v", disks)
	}
}

func TestStableMonitorDisksKeepsNfsAndPodMountsForServerFiltering(t *testing.T) {
	disks := stableMonitorDisks([]DiskSnapshot{
		{Path: "/", Device: "sda1", Filesystem: "ext4"},
		{Path: "/var/lib/kubelet/pods/uid/volumes/kubernetes.io~nfs/vol", Device: "192.168.5.195:/opt/onepro/hehao/vllm", Filesystem: "nfs"},
		{Path: "/var/lib/kubelet/pods/uid/volumes/kubernetes.io~csi/pvc/mount", Device: "sde1", Filesystem: "ext4"},
		{Path: "/proc", Device: "proc", Filesystem: "proc"},
	})
	if len(disks) != 3 {
		t.Fatalf("expected host disk plus NFS/CSI pod mounts in the snapshot, got %#v", disks)
	}
	if monitorDiskEligible("/var/lib/kubelet/pods/uid/volumes/kubernetes.io~nfs/vol", "nfs", "192.168.5.195:/opt/onepro/hehao/vllm") {
		t.Fatal("collection completeness should still ignore kubelet NFS mounts")
	}
}
