//go:build linux

package main

import (
	"bufio"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/tklauser/go-sysconf"
)

type linuxProcessCounters struct {
	pid        int64
	name       string
	uid        string
	cpuTicks   uint64
	memory     uint64
	readBytes  uint64
	writeBytes uint64
}

type linuxSystemCounters struct {
	capturedAt            time.Time
	diskReadBytes         uint64
	diskWriteBytes        uint64
	diskReadOps           uint64
	diskWriteOps          uint64
	networkReceiveBytes   uint64
	networkTransmitBytes  uint64
	networkReceiveErrors  uint64
	networkTransmitErrors uint64
	networkReceiveDrops   uint64
	networkTransmitDrops  uint64
	swapInPages           uint64
	swapOutPages          uint64
	processes             map[int64]linuxProcessCounters
}

func captureLinuxSystemCounters() linuxSystemCounters {
	result := linuxSystemCounters{capturedAt: time.Now(), processes: make(map[int64]linuxProcessCounters)}
	result.diskReadBytes, result.diskWriteBytes, result.diskReadOps, result.diskWriteOps = readDiskCounters()
	result.networkReceiveBytes, result.networkTransmitBytes,
		result.networkReceiveErrors, result.networkTransmitErrors,
		result.networkReceiveDrops, result.networkTransmitDrops = readNetworkCounters()
	result.swapInPages, result.swapOutPages = readSwapCounters()
	result.processes = readProcessCounters()
	return result
}

func applyLinuxDiagnostics(snapshot *CollectionSnapshot, before, after linuxSystemCounters) {
	seconds := after.capturedAt.Sub(before.capturedAt).Seconds()
	if seconds <= 0 {
		return
	}
	snapshot.Host.DiskReadBytesPerSecond = counterRate(before.diskReadBytes, after.diskReadBytes, seconds)
	snapshot.Host.DiskWriteBytesPerSecond = counterRate(before.diskWriteBytes, after.diskWriteBytes, seconds)
	snapshot.Host.DiskReadOpsPerSecond = counterRate(before.diskReadOps, after.diskReadOps, seconds)
	snapshot.Host.DiskWriteOpsPerSecond = counterRate(before.diskWriteOps, after.diskWriteOps, seconds)
	snapshot.Host.NetworkReceiveBytesPerSecond = counterRate(before.networkReceiveBytes, after.networkReceiveBytes, seconds)
	snapshot.Host.NetworkTransmitBytesPerSecond = counterRate(before.networkTransmitBytes, after.networkTransmitBytes, seconds)
	snapshot.Host.NetworkReceiveErrorsPerSecond = counterRate(before.networkReceiveErrors, after.networkReceiveErrors, seconds)
	snapshot.Host.NetworkTransmitErrorsPerSecond = counterRate(before.networkTransmitErrors, after.networkTransmitErrors, seconds)
	snapshot.Host.NetworkReceiveDropsPerSecond = counterRate(before.networkReceiveDrops, after.networkReceiveDrops, seconds)
	snapshot.Host.NetworkTransmitDropsPerSecond = counterRate(before.networkTransmitDrops, after.networkTransmitDrops, seconds)
	pageSize := float64(os.Getpagesize())
	snapshot.Host.SwapInBytesPerSecond = counterRate(before.swapInPages, after.swapInPages, seconds) * pageSize
	snapshot.Host.SwapOutBytesPerSecond = counterRate(before.swapOutPages, after.swapOutPages, seconds) * pageSize
	snapshot.Host.CPUPressure = readPressure("/proc/pressure/cpu")
	snapshot.Host.MemoryPressure = readPressure("/proc/pressure/memory")
	snapshot.Host.IOPressure = readPressure("/proc/pressure/io")
	snapshot.Host.TopProcesses = topProcesses(before.processes, after.processes, seconds, snapshot.Candidates)
	if snapshot.Host.CPUCount > 0 {
		for index := range snapshot.Host.TopProcesses {
			snapshot.Host.TopProcesses[index].CPUUsedPercent /= float64(snapshot.Host.CPUCount)
		}
	}
}

func counterRate(before, after uint64, seconds float64) float64 {
	if seconds <= 0 || after < before {
		return 0
	}
	return float64(after-before) / seconds
}

func readDiskCounters() (readBytes, writeBytes, readOps, writeOps uint64) {
	content, err := os.ReadFile("/proc/diskstats")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 14 {
			continue
		}
		device := fields[2]
		if _, err := os.Stat(filepath.Join("/sys/block", device)); err != nil {
			continue
		}
		if strings.HasPrefix(device, "loop") || strings.HasPrefix(device, "ram") || strings.HasPrefix(device, "fd") {
			continue
		}
		if slaves, err := os.ReadDir(filepath.Join("/sys/block", device, "slaves")); err == nil && len(slaves) > 0 {
			continue
		}
		reads := parseUint(fields[3])
		sectorsRead := parseUint(fields[5])
		writes := parseUint(fields[7])
		sectorsWritten := parseUint(fields[9])
		readOps += reads
		writeOps += writes
		readBytes += sectorsRead * 512
		writeBytes += sectorsWritten * 512
	}
	return
}

func readNetworkCounters() (receiveBytes, transmitBytes, receiveErrors, transmitErrors, receiveDrops, transmitDrops uint64) {
	content, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(content), "\n") {
		separator := strings.IndexByte(line, ':')
		if separator < 0 {
			continue
		}
		name := strings.TrimSpace(line[:separator])
		if name == "" || name == "lo" {
			continue
		}
		fields := strings.Fields(line[separator+1:])
		if len(fields) < 16 {
			continue
		}
		receiveBytes += parseUint(fields[0])
		receiveErrors += parseUint(fields[2])
		receiveDrops += parseUint(fields[3])
		transmitBytes += parseUint(fields[8])
		transmitErrors += parseUint(fields[10])
		transmitDrops += parseUint(fields[11])
	}
	return
}

func readSwapCounters() (inPages, outPages uint64) {
	file, err := os.Open("/proc/vmstat")
	if err != nil {
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 {
			continue
		}
		switch fields[0] {
		case "pswpin":
			inPages = parseUint(fields[1])
		case "pswpout":
			outPages = parseUint(fields[1])
		}
	}
	return
}

func readPressure(path string) PressureSnapshot {
	content, err := os.ReadFile(path)
	if err != nil {
		return PressureSnapshot{}
	}
	result := PressureSnapshot{}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		values := map[string]float64{}
		for _, field := range fields[1:] {
			parts := strings.SplitN(field, "=", 2)
			if len(parts) != 2 {
				continue
			}
			values[parts[0]], _ = strconv.ParseFloat(parts[1], 64)
		}
		if fields[0] == "some" {
			result.SomeAvg10 = values["avg10"]
			result.SomeAvg60 = values["avg60"]
			result.SomeAvg300 = values["avg300"]
		} else if fields[0] == "full" {
			result.FullAvg10 = values["avg10"]
			result.FullAvg60 = values["avg60"]
			result.FullAvg300 = values["avg300"]
		}
	}
	return result
}

func readProcessCounters() map[int64]linuxProcessCounters {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return map[int64]linuxProcessCounters{}
	}
	result := make(map[int64]linuxProcessCounters)
	pageSize := uint64(os.Getpagesize())
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.ParseInt(entry.Name(), 10, 64)
		if err != nil || pid <= 0 {
			continue
		}
		stat, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		text := string(stat)
		left := strings.IndexByte(text, '(')
		right := strings.LastIndexByte(text, ')')
		if left < 0 || right <= left {
			continue
		}
		fields := strings.Fields(text[right+1:])
		if len(fields) < 22 {
			continue
		}
		counters := linuxProcessCounters{
			pid:      pid,
			name:     text[left+1 : right],
			cpuTicks: parseUint(fields[11]) + parseUint(fields[12]),
			memory:   parseUint(fields[21]) * pageSize,
		}
		status, _ := os.ReadFile(filepath.Join("/proc", entry.Name(), "status"))
		for _, line := range strings.Split(string(status), "\n") {
			if strings.HasPrefix(line, "Uid:") {
				parts := strings.Fields(line)
				if len(parts) > 1 {
					counters.uid = parts[1]
				}
				break
			}
		}
		ioContent, _ := os.ReadFile(filepath.Join("/proc", entry.Name(), "io"))
		for _, line := range strings.Split(string(ioContent), "\n") {
			parts := strings.Fields(line)
			if len(parts) != 2 {
				continue
			}
			switch strings.TrimSuffix(parts[0], ":") {
			case "read_bytes":
				counters.readBytes = parseUint(parts[1])
			case "write_bytes":
				counters.writeBytes = parseUint(parts[1])
			}
		}
		result[pid] = counters
	}
	return result
}

func topProcesses(before, after map[int64]linuxProcessCounters, seconds float64, candidates []ServiceCandidate) []ProcessSnapshot {
	clockTicks, err := sysconf.Sysconf(sysconf.SC_CLK_TCK)
	if err != nil || clockTicks <= 0 {
		clockTicks = 100
	}
	processes := make([]ProcessSnapshot, 0, len(after))
	for pid, current := range after {
		previous, exists := before[pid]
		if !exists || current.cpuTicks < previous.cpuTicks {
			continue
		}
		process := ProcessSnapshot{
			PID:                     pid,
			Name:                    current.name,
			CPUUsedPercent:          float64(current.cpuTicks-previous.cpuTicks) / float64(clockTicks) / seconds * 100,
			MemoryBytes:             current.memory,
			DiskReadBytesPerSecond:  counterRate(previous.readBytes, current.readBytes, seconds),
			DiskWriteBytesPerSecond: counterRate(previous.writeBytes, current.writeBytes, seconds),
		}
		processes = append(processes, process)
	}
	selected := make(map[int64]ProcessSnapshot)
	selectTop := func(read func(ProcessSnapshot) float64) {
		sorted := append([]ProcessSnapshot(nil), processes...)
		sort.Slice(sorted, func(left, right int) bool { return read(sorted[left]) > read(sorted[right]) })
		for _, process := range sorted[:min(5, len(sorted))] {
			if read(process) > 0 {
				selected[process.PID] = process
			}
		}
	}
	selectTop(func(process ProcessSnapshot) float64 { return process.CPUUsedPercent })
	selectTop(func(process ProcessSnapshot) float64 { return float64(process.MemoryBytes) })
	selectTop(func(process ProcessSnapshot) float64 {
		return process.DiskReadBytesPerSecond + process.DiskWriteBytesPerSecond
	})
	uidNames := make(map[string]string)
	workloads := make(map[int64]ServiceCandidate)
	for _, candidate := range candidates {
		if candidate.PID > 0 {
			workloads[candidate.PID] = candidate
		}
	}
	result := make([]ProcessSnapshot, 0, len(selected))
	for pid, process := range selected {
		current := after[pid]
		if executable, err := os.Readlink(filepath.Join("/proc", strconv.FormatInt(pid, 10), "exe")); err == nil {
			process.Executable = filepath.Base(executable)
		}
		if current.uid != "" {
			name, exists := uidNames[current.uid]
			if !exists {
				name = current.uid
				if account, lookupErr := user.LookupId(current.uid); lookupErr == nil && account.Username != "" {
					name = account.Username
				}
				uidNames[current.uid] = name
			}
			process.User = name
		}
		if workload, exists := workloads[pid]; exists {
			process.WorkloadProvider = workload.Provider
			process.WorkloadID = workload.ExternalID
			process.WorkloadName = workload.Name
		}
		result = append(result, process)
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].CPUUsedPercent == result[right].CPUUsedPercent {
			return result[left].MemoryBytes > result[right].MemoryBytes
		}
		return result[left].CPUUsedPercent > result[right].CPUUsedPercent
	})
	return result
}

func parseUint(value string) uint64 {
	parsed, _ := strconv.ParseUint(value, 10, 64)
	return parsed
}
