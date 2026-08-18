//go:build !linux

package main

import "time"

type Collector struct{}

func NewCollector(_ string) *Collector { return &Collector{} }
func (*Collector) Close()              {}
func (*Collector) Collect(interval time.Duration) CollectionSnapshot {
	return CollectionSnapshot{
		CollectedAt:       time.Now().UTC().Format(time.RFC3339Nano),
		ResolutionSeconds: max(1, int(interval.Round(time.Second)/time.Second)),
		SampleCount:       1,
		Host:              HostSnapshot{Disks: []DiskSnapshot{}, Temperatures: []TemperatureSnapshot{}},
		Candidates:        []ServiceCandidate{},
		KubernetesConfigs: []KubernetesConfigDiscovery{},
		Errors:            []string{"viron-monitor collection is supported on Linux only"},
	}
}
