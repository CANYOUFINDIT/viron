//go:build linux

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

type Collector struct {
	path                    string
	kubernetesSelectionFile string
}

func NewCollector(dataDir string) *Collector {
	selectionFile := filepath.Join(dataDir, "kubernetes-selection.json")
	if configured := os.Getenv("VIRON_MONITOR_COLLECTOR"); configured != "" {
		return &Collector{path: configured, kubernetesSelectionFile: selectionFile}
	}
	executable, err := os.Executable()
	if err != nil {
		return &Collector{path: "viron-monitor-collector", kubernetesSelectionFile: selectionFile}
	}
	return &Collector{path: filepath.Join(filepath.Dir(executable), "viron-monitor-collector"), kubernetesSelectionFile: selectionFile}
}

func (*Collector) Close() {}

func (c *Collector) Collect(interval time.Duration) CollectionSnapshot {
	timeout := max(15*time.Second, min(interval, 2*time.Minute))
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, c.path, "--interval", interval.String())
	command.Env = append(os.Environ(), "VIRON_MONITOR_KUBERNETES_SELECTION_FILE="+c.kubernetesSelectionFile)
	output, err := command.Output()
	if err != nil {
		return failedCollection(interval, fmt.Sprintf("running monitor collector: %v", err))
	}
	var snapshot CollectionSnapshot
	if err := json.Unmarshal(output, &snapshot); err != nil {
		return failedCollection(interval, fmt.Sprintf("decoding monitor collector output: %v", err))
	}
	if snapshot.Host.CollectorUser == "" {
		snapshot.Host.CollectorUser = processUser()
	}
	return snapshot
}

func failedCollection(interval time.Duration, message string) CollectionSnapshot {
	return CollectionSnapshot{
		CollectedAt:       time.Now().UTC().Format(time.RFC3339Nano),
		ResolutionSeconds: max(1, int(interval.Round(time.Second)/time.Second)),
		SampleCount:       1,
		Host:              HostSnapshot{Hostname: hostname(), CollectorUser: processUser(), Disks: []DiskSnapshot{}, Temperatures: []TemperatureSnapshot{}},
		Candidates:        []ServiceCandidate{},
		KubernetesConfigs: []KubernetesConfigDiscovery{},
		Errors:            []string{message},
	}
}

func processUser() string {
	if os.Geteuid() == 0 {
		return "root"
	}
	return strconv.Itoa(os.Geteuid())
}
