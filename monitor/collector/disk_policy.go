package main

import (
	"sort"
	"strings"
)

const (
	diskCollectionComplete = "complete"
	diskCollectionPartial  = "partial"
	diskCollectionFailed   = "failed"
)

var virtualDiskFilesystems = map[string]struct{}{
	"autofs": {}, "cgroup": {}, "cgroup2": {}, "configfs": {}, "debugfs": {},
	"devfs": {}, "devtmpfs": {}, "fuse.lxcfs": {}, "fuse.portal": {}, "fusectl": {},
	"hugetlbfs": {}, "mqueue": {}, "nsfs": {}, "overlay": {}, "proc": {}, "pstore": {},
	"securityfs": {}, "squashfs": {}, "sysfs": {}, "tmpfs": {}, "tracefs": {},
}

var ignoredDiskFilesystems = map[string]struct{}{
	"9p": {}, "autofs": {}, "ceph": {}, "cgroup": {}, "cgroup2": {}, "cifs": {},
	"configfs": {}, "debugfs": {}, "devfs": {}, "devtmpfs": {}, "fuse.lxcfs": {},
	"fuse.portal": {}, "fusectl": {}, "glusterfs": {}, "hugetlbfs": {}, "mqueue": {},
	"nfs": {}, "nfs4": {}, "nsfs": {}, "overlay": {}, "proc": {}, "pstore": {},
	"securityfs": {}, "smb3": {}, "squashfs": {}, "sysfs": {}, "tmpfs": {}, "tracefs": {},
}

var ignoredDiskMountRoots = []string{
	"/run/containerd",
	"/run/credentials",
	"/run/docker",
	"/run/k3s/containerd",
	"/run/systemd/unit-root",
	"/var/lib/containers/storage/overlay",
	"/var/lib/containers/storage/overlay-containers",
	"/var/lib/containers/storage/volumes",
	"/var/lib/docker/containers",
	"/var/lib/docker/overlay2",
	"/var/lib/docker/volumes",
	"/var/lib/kubelet/plugins",
	"/var/lib/kubelet/plugins_registry",
	"/var/lib/kubelet/pods",
	"/var/lib/rancher/k3s/agent/containerd",
}

func monitorDiskCollectable(path, filesystem, _ string) bool {
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	filesystem = strings.ToLower(strings.TrimSpace(filesystem))
	if _, ignored := virtualDiskFilesystems[filesystem]; ignored {
		return false
	}
	return true
}

func monitorDiskEligible(path, filesystem, device string) bool {
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	device = strings.TrimSpace(device)
	if strings.HasPrefix(device, "//") || strings.Contains(device, ":/") {
		return false
	}
	filesystem = strings.ToLower(strings.TrimSpace(filesystem))
	if _, ignored := ignoredDiskFilesystems[filesystem]; ignored {
		return false
	}
	for _, root := range ignoredDiskMountRoots {
		if path == root || strings.HasPrefix(path, root+"/") {
			return false
		}
	}
	return true
}

func normalizedDiskDevice(device, filesystem, path string) string {
	device = strings.TrimSpace(strings.TrimPrefix(device, "/dev/"))
	if device == "" || device == "none" {
		device = strings.ToLower(strings.TrimSpace(filesystem))
	}
	if device == "" {
		return "path:" + strings.TrimSpace(path)
	}
	return device
}

func preferredDisk(left, right DiskSnapshot) DiskSnapshot {
	leftDepth := strings.Count(strings.Trim(left.Path, "/"), "/")
	rightDepth := strings.Count(strings.Trim(right.Path, "/"), "/")
	if left.Path == "/" {
		leftDepth = -1
	}
	if right.Path == "/" {
		rightDepth = -1
	}
	if leftDepth != rightDepth {
		if leftDepth < rightDepth {
			return left
		}
		return right
	}
	if len(left.Path) != len(right.Path) {
		if len(left.Path) < len(right.Path) {
			return left
		}
		return right
	}
	if left.Path <= right.Path {
		return left
	}
	return right
}

func stableMonitorDisks(disks []DiskSnapshot) []DiskSnapshot {
	byDevice := make(map[string]DiskSnapshot, len(disks))
	for _, candidate := range disks {
		if !monitorDiskCollectable(candidate.Path, candidate.Filesystem, candidate.Device) {
			continue
		}
		key := normalizedDiskDevice(candidate.Device, candidate.Filesystem, candidate.Path)
		if current, exists := byDevice[key]; exists {
			byDevice[key] = preferredDisk(current, candidate)
		} else {
			byDevice[key] = candidate
		}
	}
	result := make([]DiskSnapshot, 0, len(byDevice))
	for _, disk := range byDevice {
		result = append(result, disk)
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].Path == result[right].Path {
			return result[left].Device < result[right].Device
		}
		return result[left].Path < result[right].Path
	})
	return result
}
