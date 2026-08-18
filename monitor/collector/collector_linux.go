//go:build linux

package main

// This binary embeds only the Telegraf plugins selected below.

import (
	"fmt"
	"os"
	"os/user"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/config"
	"github.com/influxdata/telegraf/plugins/inputs"
	inputcpu "github.com/influxdata/telegraf/plugins/inputs/cpu"
	inputdisk "github.com/influxdata/telegraf/plugins/inputs/disk"
	inputdocker "github.com/influxdata/telegraf/plugins/inputs/docker"
	inputmem "github.com/influxdata/telegraf/plugins/inputs/mem"
	inputsensors "github.com/influxdata/telegraf/plugins/inputs/sensors"
	inputsupervisor "github.com/influxdata/telegraf/plugins/inputs/supervisor"
	inputsystem "github.com/influxdata/telegraf/plugins/inputs/system"
	inputsystemd "github.com/influxdata/telegraf/plugins/inputs/systemd_units"
)

type managedInput struct {
	name   string
	input  telegraf.Input
	stop   func()
	active bool
	tags   map[string]string
}

type Collector struct {
	inputs        []*managedInput
	startupErrors []string
	cpuWarmed     bool
}

func NewCollector() *Collector {
	collector := &Collector{}
	collector.add("cpu", func(input telegraf.Input) {
		plugin := input.(*inputcpu.CPU)
		plugin.PerCPU = false
		plugin.TotalCPU = true
		plugin.ReportActive = true
		plugin.Log = &pluginLogger{name: "cpu"}
	})
	collector.add("mem", func(input telegraf.Input) {
		input.(*inputmem.Mem).Log = &pluginLogger{name: "mem"}
	})
	collector.add("system", func(input telegraf.Input) {
		plugin := input.(*inputsystem.System)
		plugin.Include = []string{"legacy", "os"}
		plugin.OSCacheTTL = config.Duration(10 * time.Minute)
		plugin.Log = &pluginLogger{name: "system"}
	})
	collector.add("disk", func(input telegraf.Input) {
		plugin := input.(*inputdisk.Disk)
		plugin.IgnoreFS = []string{"tmpfs", "devtmpfs", "devfs", "overlay", "squashfs", "nsfs", "proc", "sysfs", "cgroup", "cgroup2", "tracefs", "debugfs", "securityfs", "pstore", "configfs", "fusectl", "mqueue", "hugetlbfs"}
		plugin.Log = &pluginLogger{name: "disk"}
	})
	collector.add("systemd_units", func(input telegraf.Input) {
		plugin := input.(*inputsystemd.SystemdUnits)
		plugin.Pattern = "*"
		plugin.UnitType = "service"
		plugin.Scope = "system"
		plugin.Details = true
		plugin.Timeout = config.Duration(5 * time.Second)
		plugin.Log = &pluginLogger{name: "systemd_units"}
	})
	dockerProvider := "docker"
	dockerEndpoint := ""
	if endpoint := strings.TrimSpace(os.Getenv("DOCKER_HOST")); endpoint != "" {
		dockerEndpoint = "ENV"
		if strings.Contains(strings.ToLower(endpoint), "podman") {
			dockerProvider = "podman"
		}
	}
	collector.addContainer(dockerProvider, "docker", dockerEndpoint)

	podmanEndpoints := splitNonEmpty(os.Getenv("VIRON_MONITOR_PODMAN_ENDPOINTS"))
	if len(podmanEndpoints) == 0 {
		if _, err := os.Stat("/run/podman/podman.sock"); err == nil {
			podmanEndpoints = []string{"unix:///run/podman/podman.sock"}
		}
	}
	for index, endpoint := range podmanEndpoints {
		collector.addContainer("podman", fmt.Sprintf("podman[%d]", index), endpoint)
	}

	collector.add("sensors", func(input telegraf.Input) {
		plugin := input.(*inputsensors.Sensors)
		plugin.RemoveNumbers = false
		plugin.Timeout = config.Duration(5 * time.Second)
	})

	supervisorURLs := splitNonEmpty(os.Getenv("VIRON_MONITOR_SUPERVISOR_URLS"))
	if len(supervisorURLs) == 0 {
		supervisorURLs = []string{"http://127.0.0.1:9001/RPC2"}
	}
	for index, serverURL := range supervisorURLs {
		collector.addNamed("supervisor", fmt.Sprintf("supervisor[%d]", index), func(input telegraf.Input) {
			plugin := input.(*inputsupervisor.Supervisor)
			plugin.Server = serverURL
			plugin.MetricsExc = nil
			plugin.Log = &pluginLogger{name: "supervisor"}
		})
	}
	return collector
}

func (c *Collector) addContainer(provider, displayName, endpoint string) {
	c.addNamedWithTags("docker", displayName, map[string]string{"viron_provider": provider}, func(input telegraf.Input) {
		plugin := input.(*inputdocker.Docker)
		plugin.Endpoint = endpoint
		plugin.ContainerStateInclude = []string{"created", "restarting", "running", "removing", "paused", "exited", "dead"}
		plugin.Timeout = config.Duration(5 * time.Second)
		plugin.PodmanCacheTTL = config.Duration(2 * time.Minute)
		plugin.Log = &pluginLogger{name: displayName}
	})
}

func (c *Collector) add(name string, configure func(telegraf.Input)) {
	c.addNamed(name, name, configure)
}

func (c *Collector) addNamed(registryName, displayName string, configure func(telegraf.Input)) {
	c.addNamedWithTags(registryName, displayName, nil, configure)
}

func (c *Collector) addNamedWithTags(registryName, displayName string, tags map[string]string, configure func(telegraf.Input)) {
	factory := inputs.Inputs[registryName]
	if factory == nil {
		c.startupErrors = append(c.startupErrors, fmt.Sprintf("%s collector is unavailable", displayName))
		return
	}
	input := factory()
	configure(input)
	if initializer, ok := input.(telegraf.Initializer); ok {
		if err := initializer.Init(); err != nil {
			c.startupErrors = append(c.startupErrors, fmt.Sprintf("%s: %s", displayName, redactError(err)))
			return
		}
	}
	managed := &managedInput{name: displayName, input: input, active: true, tags: tags}
	if service, ok := input.(telegraf.ServiceInput); ok {
		if err := service.Start(&metricAccumulator{}); err != nil {
			c.startupErrors = append(c.startupErrors, fmt.Sprintf("%s: %s", displayName, redactError(err)))
			return
		}
		managed.stop = service.Stop
	}
	c.inputs = append(c.inputs, managed)
}

func (c *Collector) Close() {
	for _, input := range c.inputs {
		if input.stop != nil {
			input.stop()
		}
	}
}

func (c *Collector) Collect(interval time.Duration) CollectionSnapshot {
	before := captureLinuxSystemCounters()
	accumulator := &metricAccumulator{}
	for _, input := range c.inputs {
		if !input.active {
			continue
		}
		var inputAccumulator telegraf.Accumulator = accumulator
		if len(input.tags) > 0 {
			inputAccumulator = &taggedAccumulator{target: accumulator, tags: input.tags}
		}
		if err := input.input.Gather(inputAccumulator); err != nil {
			accumulator.AddError(fmt.Errorf("%s: %w", input.name, err))
		}
	}
	if !c.cpuWarmed {
		c.cpuWarmed = true
		time.Sleep(250 * time.Millisecond)
		for _, input := range c.inputs {
			if input.name == "cpu" {
				if err := input.input.Gather(accumulator); err != nil {
					accumulator.AddError(fmt.Errorf("cpu: %w", err))
				}
				break
			}
		}
	}
	after := captureLinuxSystemCounters()
	metrics, collectionErrors := accumulator.snapshot()
	errors := append([]string(nil), c.startupErrors...)
	for _, err := range collectionErrors {
		errors = append(errors, redactError(err))
	}
	if len(errors) > 20 {
		errors = errors[:20]
	}
	snapshot := normalizeMetrics(metrics, errors, interval)
	kubernetesConfigs, kubernetesCandidates, kubernetesErrors := collectKubernetes()
	snapshot.KubernetesConfigs = kubernetesConfigs
	snapshot.Candidates = append(snapshot.Candidates, kubernetesCandidates...)
	snapshot.Errors = uniqueStrings(append(snapshot.Errors, kubernetesErrors...))
	applyLinuxDiagnostics(&snapshot, before, after)
	if len(snapshot.Candidates) > 10_000 {
		snapshot.Candidates = snapshot.Candidates[:10_000]
		snapshot.Errors = uniqueStrings(append(snapshot.Errors, "服务扫描候选超过 10000 项，已截断"))
	}
	if len(snapshot.Errors) > 20 {
		snapshot.Errors = snapshot.Errors[:20]
	}
	sort.Slice(snapshot.Candidates, func(left, right int) bool {
		if snapshot.Candidates[left].Provider == snapshot.Candidates[right].Provider {
			return snapshot.Candidates[left].Name < snapshot.Candidates[right].Name
		}
		return snapshot.Candidates[left].Provider < snapshot.Candidates[right].Provider
	})
	return snapshot
}

func normalizeMetrics(metrics []capturedMetric, errors []string, interval time.Duration) CollectionSnapshot {
	hostname, _ := os.Hostname()
	collectedAt := time.Now().UTC()
	snapshot := CollectionSnapshot{
		CollectedAt:       collectedAt.Format(time.RFC3339Nano),
		ResolutionSeconds: max(1, int(interval.Round(time.Second)/time.Second)),
		SampleCount:       1,
		Host: HostSnapshot{
			Hostname:       hostname,
			MetricsVersion: 2,
			CollectorUser:  collectorUser(),
			Disks:          []DiskSnapshot{},
			Temperatures:   []TemperatureSnapshot{},
			TopProcesses:   []ProcessSnapshot{},
		},
		Candidates:        []ServiceCandidate{},
		KubernetesConfigs: []KubernetesConfigDiscovery{},
		Errors:            uniqueStrings(errors),
	}
	candidates := make(map[string]*ServiceCandidate)
	containerByName := make(map[string]*ServiceCandidate)
	for _, metric := range metrics {
		switch metric.Name {
		case "cpu":
			if metric.Tags["cpu"] == "cpu-total" || metric.Tags["cpu"] == "cpu_total" {
				if value, exists := metric.Fields["usage_active"]; exists {
					snapshot.Host.CPUUsedPercent = floatValue(value)
				} else if value, exists := metric.Fields["usage_idle"]; exists {
					snapshot.Host.CPUUsedPercent = 100 - floatValue(value)
				}
				snapshot.Host.CPUUserPercent = floatValue(metric.Fields["usage_user"])
				snapshot.Host.CPUSystemPercent = floatValue(metric.Fields["usage_system"])
				snapshot.Host.CPUIOWaitPercent = floatValue(metric.Fields["usage_iowait"])
				snapshot.Host.CPUStealPercent = floatValue(metric.Fields["usage_steal"])
			}
		case "mem":
			snapshot.Host.MemoryTotalBytes = uint64Value(metric.Fields["total"])
			snapshot.Host.MemoryUsedBytes = uint64Value(metric.Fields["used"])
			snapshot.Host.MemoryUsedPercent = floatValue(metric.Fields["used_percent"])
			swapTotal := uint64Value(metric.Fields["swap_total"])
			swapFree := uint64Value(metric.Fields["swap_free"])
			snapshot.Host.SwapTotalBytes = swapTotal
			if swapTotal > swapFree {
				snapshot.Host.SwapUsedBytes = swapTotal - swapFree
				snapshot.Host.SwapUsedPercent = float64(snapshot.Host.SwapUsedBytes) / float64(swapTotal) * 100
			}
		case "system":
			snapshot.Host.Load1 = floatValue(metric.Fields["load1"])
			snapshot.Host.Load5 = floatValue(metric.Fields["load5"])
			snapshot.Host.Load15 = floatValue(metric.Fields["load15"])
			snapshot.Host.CPUCount = int(floatValue(metric.Fields["n_cpus"]))
			snapshot.Host.UptimeSeconds = uint64Value(metric.Fields["uptime"])
			if value, ok := metric.Fields["platform"].(string); ok {
				snapshot.Host.OperatingSystem = value
			}
			if value, ok := metric.Fields["arch"].(string); ok {
				snapshot.Host.Architecture = value
			}
			if value, ok := metric.Fields["kernel_version"].(string); ok {
				snapshot.Host.KernelVersion = value
			}
		case "disk":
			snapshot.Host.Disks = append(snapshot.Host.Disks, DiskSnapshot{
				Path:        metric.Tags["path"],
				Device:      metric.Tags["device"],
				Filesystem:  metric.Tags["fstype"],
				TotalBytes:  uint64Value(metric.Fields["total"]),
				FreeBytes:   uint64Value(metric.Fields["free"]),
				UsedBytes:   uint64Value(metric.Fields["used"]),
				UsedPercent: floatValue(metric.Fields["used_percent"]),
			})
		case "sensors":
			for field, value := range metric.Fields {
				if !strings.Contains(field, "temp") || !strings.HasSuffix(field, "_input") {
					continue
				}
				prefix := strings.TrimSuffix(field, "_input")
				snapshot.Host.Temperatures = append(snapshot.Host.Temperatures, TemperatureSnapshot{
					Chip:     metric.Tags["chip"],
					Feature:  metric.Tags["feature"],
					Celsius:  floatValue(value),
					Maximum:  floatValue(metric.Fields[prefix+"_max"]),
					Critical: floatValue(metric.Fields[prefix+"_crit"]),
				})
			}
		case "systemd_units":
			name := metric.Tags["name"]
			if name == "" {
				continue
			}
			state := metric.Tags["active"]
			candidate := ServiceCandidate{
				Provider:     "systemd",
				ExternalID:   name,
				Name:         strings.TrimSuffix(name, ".service"),
				Status:       systemdStatus(state, metric.Tags["sub"]),
				State:        joinState(state, metric.Tags["sub"]),
				PID:          int64Value(metric.Fields["pid"]),
				MemoryBytes:  uint64Value(metric.Fields["mem_current"]),
				RestartCount: uint64Value(metric.Fields["restarts"]),
				Metadata: map[string]interface{}{
					"load":          metric.Tags["load"],
					"unitFileState": metric.Tags["state"],
				},
			}
			if enteredAt := uint64Value(metric.Fields["active_enter_timestamp_us"]); enteredAt > 0 && uint64(collectedAt.UnixMicro()) > enteredAt {
				candidate.UptimeSeconds = (uint64(collectedAt.UnixMicro()) - enteredAt) / uint64(time.Second/time.Microsecond)
			}
			candidates[candidate.Provider+":"+candidate.ExternalID] = &candidate
		case "docker_container_status", "docker_container_mem", "docker_container_cpu", "docker_container_health":
			provider := containerProvider(metric.Tags)
			containerID, _ := metric.Fields["container_id"].(string)
			name := metric.Tags["container_name"]
			if containerID == "" && metric.Name == "docker_container_health" {
				candidate := containerByName[provider+":"+metric.Tags["engine_host"]+":"+name]
				if candidate != nil {
					applyContainerHealth(candidate, metric.Fields["health_status"])
				}
				continue
			}
			if containerID == "" {
				continue
			}
			key := provider + ":" + containerID
			candidate := candidates[key]
			if candidate == nil {
				externalID := firstNonEmpty(name, containerID)
				candidate = &ServiceCandidate{
					Provider:   provider,
					ExternalID: externalID,
					Name:       firstNonEmpty(name, containerID[:min(12, len(containerID))]),
					Status:     containerStatus(metric.Tags["container_status"]),
					State:      metric.Tags["container_status"],
					Metadata: map[string]interface{}{
						"containerId": containerID,
						"image":       metric.Tags["container_image"],
						"engineHost":  metric.Tags["engine_host"],
					},
				}
				candidates[key] = candidate
				containerByName[provider+":"+metric.Tags["engine_host"]+":"+name] = candidate
			}
			if metric.Name == "docker_container_status" {
				candidate.Status = containerStatus(metric.Tags["container_status"])
				candidate.State = metric.Tags["container_status"]
				candidate.PID = int64Value(metric.Fields["pid"])
				candidate.RestartCount = uint64Value(metric.Fields["restart_count"])
				candidate.UptimeSeconds = uint64Value(metric.Fields["uptime_ns"]) / uint64(time.Second)
			}
			if metric.Name == "docker_container_mem" {
				candidate.MemoryBytes = uint64Value(metric.Fields["usage"])
			}
			if metric.Name == "docker_container_cpu" && (metric.Tags["cpu"] == "cpu-total" || metric.Tags["cpu"] == "cpu_total") {
				candidate.CPUUsedPercent = floatValue(metric.Fields["usage_percent"])
			}
		case "supervisor_processes":
			name := firstNonEmpty(metric.Tags["name"], metric.Tags["process"])
			if name == "" {
				continue
			}
			group := metric.Tags["group"]
			externalID := name
			if group != "" && group != name {
				externalID = group + ":" + name
			}
			stateCode := int(floatValue(metric.Fields["state"]))
			candidate := ServiceCandidate{
				Provider:      "supervisor",
				ExternalID:    externalID,
				Name:          name,
				Group:         group,
				Status:        supervisorStatus(stateCode),
				State:         supervisorState(stateCode),
				PID:           int64Value(metric.Fields["pid"]),
				UptimeSeconds: uint64Value(metric.Fields["uptime"]),
				Metadata:      map[string]interface{}{"source": metric.Tags["source"]},
			}
			candidates[candidate.Provider+":"+candidate.ExternalID] = &candidate
		}
	}
	for _, candidate := range candidates {
		snapshot.Candidates = append(snapshot.Candidates, *candidate)
	}
	sort.Slice(snapshot.Candidates, func(left, right int) bool {
		if snapshot.Candidates[left].Provider == snapshot.Candidates[right].Provider {
			return snapshot.Candidates[left].Name < snapshot.Candidates[right].Name
		}
		return snapshot.Candidates[left].Provider < snapshot.Candidates[right].Provider
	})
	sort.Slice(snapshot.Host.Disks, func(left, right int) bool { return snapshot.Host.Disks[left].Path < snapshot.Host.Disks[right].Path })
	return snapshot
}

func collectorUser() string {
	if os.Geteuid() == 0 {
		return "root"
	}
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.Username) != "" {
		return current.Username
	}
	return strconv.Itoa(os.Geteuid())
}

func systemdStatus(active, sub string) CandidateStatus {
	switch active {
	case "active":
		if sub == "failed" || sub == "auto-restart" {
			return StatusDegraded
		}
		return StatusRunning
	case "failed":
		return StatusDegraded
	case "inactive":
		return StatusStopped
	case "activating", "deactivating", "reloading":
		return StatusDegraded
	default:
		return StatusUnknown
	}
}

func containerStatus(state string) CandidateStatus {
	switch state {
	case "running":
		return StatusRunning
	case "created", "exited", "dead", "removing":
		return StatusStopped
	case "restarting", "paused":
		return StatusDegraded
	default:
		return StatusUnknown
	}
}

func containerProvider(tags map[string]string) string {
	if provider := tags["viron_provider"]; provider == "podman" {
		return provider
	}
	return "docker"
}

func applyContainerHealth(candidate *ServiceCandidate, value interface{}) {
	health, ok := value.(string)
	if !ok || health == "" {
		return
	}
	candidate.Metadata["health"] = health
	if strings.EqualFold(health, "unhealthy") {
		candidate.Status = StatusDegraded
	}
}

func supervisorStatus(state int) CandidateStatus {
	switch state {
	case 20:
		return StatusRunning
	case 0, 100:
		return StatusStopped
	case 10, 30, 40, 200:
		return StatusDegraded
	default:
		return StatusUnknown
	}
}

func supervisorState(state int) string {
	states := map[int]string{0: "stopped", 10: "starting", 20: "running", 30: "backoff", 40: "stopping", 100: "exited", 200: "fatal", 1000: "unknown"}
	if value, ok := states[state]; ok {
		return value
	}
	return "unknown"
}

func joinState(primary, secondary string) string {
	if primary == "" {
		return secondary
	}
	if secondary == "" {
		return primary
	}
	return primary + "/" + secondary
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func splitNonEmpty(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		result = append(result, trimmed)
	}
	return result
}

func redactError(err error) string {
	message := err.Error()
	if marker := strings.Index(message, "://"); marker >= 0 {
		rest := message[marker+3:]
		if at := strings.Index(rest, "@"); at >= 0 && strings.Contains(rest[:at], ":") {
			message = message[:marker+3] + "***:***@" + rest[at+1:]
		}
	}
	if len(message) > 500 {
		message = message[:500]
	}
	return message
}
