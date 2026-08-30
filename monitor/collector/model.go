package main

type CandidateStatus string

const (
	StatusRunning  CandidateStatus = "running"
	StatusStopped  CandidateStatus = "stopped"
	StatusDegraded CandidateStatus = "degraded"
	StatusUnknown  CandidateStatus = "unknown"
)

type DiskSnapshot struct {
	Path        string  `json:"path"`
	Device      string  `json:"device,omitempty"`
	Filesystem  string  `json:"filesystem,omitempty"`
	TotalBytes  uint64  `json:"totalBytes"`
	FreeBytes   uint64  `json:"freeBytes"`
	UsedBytes   uint64  `json:"usedBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

type TemperatureSnapshot struct {
	Chip     string  `json:"chip"`
	Feature  string  `json:"feature,omitempty"`
	Celsius  float64 `json:"celsius"`
	Maximum  float64 `json:"maximum,omitempty"`
	Critical float64 `json:"critical,omitempty"`
}

type PressureSnapshot struct {
	SomeAvg10  float64 `json:"someAvg10"`
	SomeAvg60  float64 `json:"someAvg60"`
	SomeAvg300 float64 `json:"someAvg300"`
	FullAvg10  float64 `json:"fullAvg10"`
	FullAvg60  float64 `json:"fullAvg60"`
	FullAvg300 float64 `json:"fullAvg300"`
}

type ProcessSnapshot struct {
	PID                     int64   `json:"pid"`
	Name                    string  `json:"name"`
	Executable              string  `json:"executable,omitempty"`
	User                    string  `json:"user,omitempty"`
	CPUUsedPercent          float64 `json:"cpuUsedPercent"`
	MemoryBytes             uint64  `json:"memoryBytes"`
	DiskReadBytesPerSecond  float64 `json:"diskReadBytesPerSecond"`
	DiskWriteBytesPerSecond float64 `json:"diskWriteBytesPerSecond"`
	WorkloadProvider        string  `json:"workloadProvider,omitempty"`
	WorkloadID              string  `json:"workloadId,omitempty"`
	WorkloadName            string  `json:"workloadName,omitempty"`
}

type HostSnapshot struct {
	Hostname                       string                `json:"hostname"`
	MetricsVersion                 int                   `json:"metricsVersion"`
	DiskCollectionStatus           string                `json:"diskCollectionStatus,omitempty"`
	CollectorUser                  string                `json:"collectorUser,omitempty"`
	OperatingSystem                string                `json:"operatingSystem,omitempty"`
	Architecture                   string                `json:"architecture,omitempty"`
	KernelVersion                  string                `json:"kernelVersion,omitempty"`
	CPUCount                       int                   `json:"cpuCount"`
	CPUUsedPercent                 float64               `json:"cpuUsedPercent"`
	CPUUserPercent                 float64               `json:"cpuUserPercent"`
	CPUSystemPercent               float64               `json:"cpuSystemPercent"`
	CPUIOWaitPercent               float64               `json:"cpuIoWaitPercent"`
	CPUStealPercent                float64               `json:"cpuStealPercent"`
	Load1                          float64               `json:"load1"`
	Load5                          float64               `json:"load5"`
	Load15                         float64               `json:"load15"`
	MemoryTotalBytes               uint64                `json:"memoryTotalBytes"`
	MemoryUsedBytes                uint64                `json:"memoryUsedBytes"`
	MemoryUsedPercent              float64               `json:"memoryUsedPercent"`
	SwapTotalBytes                 uint64                `json:"swapTotalBytes"`
	SwapUsedBytes                  uint64                `json:"swapUsedBytes"`
	SwapUsedPercent                float64               `json:"swapUsedPercent"`
	SwapInBytesPerSecond           float64               `json:"swapInBytesPerSecond"`
	SwapOutBytesPerSecond          float64               `json:"swapOutBytesPerSecond"`
	UptimeSeconds                  uint64                `json:"uptimeSeconds"`
	DiskReadBytesPerSecond         float64               `json:"diskReadBytesPerSecond"`
	DiskWriteBytesPerSecond        float64               `json:"diskWriteBytesPerSecond"`
	DiskReadOpsPerSecond           float64               `json:"diskReadOpsPerSecond"`
	DiskWriteOpsPerSecond          float64               `json:"diskWriteOpsPerSecond"`
	NetworkReceiveBytesPerSecond   float64               `json:"networkReceiveBytesPerSecond"`
	NetworkTransmitBytesPerSecond  float64               `json:"networkTransmitBytesPerSecond"`
	NetworkReceiveErrorsPerSecond  float64               `json:"networkReceiveErrorsPerSecond"`
	NetworkTransmitErrorsPerSecond float64               `json:"networkTransmitErrorsPerSecond"`
	NetworkReceiveDropsPerSecond   float64               `json:"networkReceiveDropsPerSecond"`
	NetworkTransmitDropsPerSecond  float64               `json:"networkTransmitDropsPerSecond"`
	CPUPressure                    PressureSnapshot      `json:"cpuPressure"`
	MemoryPressure                 PressureSnapshot      `json:"memoryPressure"`
	IOPressure                     PressureSnapshot      `json:"ioPressure"`
	Disks                          []DiskSnapshot        `json:"disks"`
	Temperatures                   []TemperatureSnapshot `json:"temperatures"`
	TopProcesses                   []ProcessSnapshot     `json:"topProcesses"`
}

type ServiceCandidate struct {
	Provider       string                 `json:"provider"`
	ExternalID     string                 `json:"externalId"`
	Name           string                 `json:"name"`
	Group          string                 `json:"group,omitempty"`
	Status         CandidateStatus        `json:"status"`
	State          string                 `json:"state"`
	PID            int64                  `json:"pid,omitempty"`
	CPUUsedPercent float64                `json:"cpuUsedPercent,omitempty"`
	MemoryBytes    uint64                 `json:"memoryBytes,omitempty"`
	RestartCount   uint64                 `json:"restartCount,omitempty"`
	UptimeSeconds  uint64                 `json:"uptimeSeconds,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
}

type KubernetesConfigDiscovery struct {
	SourceID       string `json:"sourceId"`
	Path           string `json:"path,omitempty"`
	Context        string `json:"context,omitempty"`
	Cluster        string `json:"cluster,omitempty"`
	Namespace      string `json:"namespace,omitempty"`
	CurrentContext bool   `json:"currentContext"`
	Selected       bool   `json:"selected"`
	Status         string `json:"status"`
	CandidateCount int    `json:"candidateCount"`
	Error          string `json:"error,omitempty"`
}

type CollectionSnapshot struct {
	CollectedAt       string                      `json:"collectedAt"`
	ResolutionSeconds int                         `json:"resolutionSeconds"`
	SampleCount       int                         `json:"sampleCount"`
	Host              HostSnapshot                `json:"host"`
	Candidates        []ServiceCandidate          `json:"candidates"`
	KubernetesConfigs []KubernetesConfigDiscovery `json:"kubernetesConfigs"`
	Errors            []string                    `json:"errors"`
}
