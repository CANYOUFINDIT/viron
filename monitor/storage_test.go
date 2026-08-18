package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConfigureKubernetesWritesValidatedSelection(t *testing.T) {
	directory := t.TempDir()
	sourceID := strings.Repeat("a", 64)
	payload, err := json.Marshal(map[string]interface{}{
		"version": 1,
		"selections": []map[string]string{
			{"sourceId": sourceID, "context": "development"},
			{"sourceId": sourceID, "context": "development"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := configureKubernetes(directory, base64.StdEncoding.EncodeToString(payload)); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(directory, "kubernetes-selection.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document kubernetesSelectionDocument
	if err := json.Unmarshal(content, &document); err != nil {
		t.Fatal(err)
	}
	if document.Version != 1 || len(document.Selections) != 1 || document.Selections[0].Context != "development" {
		t.Fatalf("unexpected Kubernetes selection: %#v", document)
	}
	if info, err := os.Stat(filepath.Join(directory, "kubernetes-selection.json")); err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("unexpected Kubernetes selection permissions: %#v, %v", info, err)
	}
}

func testSnapshot(at time.Time, padding int) CollectionSnapshot {
	return CollectionSnapshot{
		CollectedAt:       at.UTC().Format(time.RFC3339Nano),
		ResolutionSeconds: 30,
		SampleCount:       1,
		Host: HostSnapshot{
			Hostname:          "test-host",
			CPUUsedPercent:    25,
			MemoryUsedPercent: 50,
			Disks:             []DiskSnapshot{},
			Temperatures:      []TemperatureSnapshot{},
		},
		Candidates:        []ServiceCandidate{{Provider: "systemd", ExternalID: "api.service", Name: "api", Status: StatusRunning, State: "active/running"}},
		KubernetesConfigs: []KubernetesConfigDiscovery{},
		Errors:            []string{strings.Repeat("x", padding)},
	}
}

func TestStoragePullAndAckRetainsLocalSamples(t *testing.T) {
	storage, err := OpenStorage(filepath.Join(t.TempDir(), "monitor.db"), 8*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	for index := 0; index < 3; index++ {
		if _, err := storage.Append(testSnapshot(time.Now().Add(time.Duration(index)*time.Second), 0)); err != nil {
			t.Fatal(err)
		}
	}
	response, err := storage.Pull(0, 2, "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Samples) != 2 || response.ThroughSequence != 2 || !response.HasMore {
		t.Fatalf("unexpected first pull: %#v", response)
	}
	if err := storage.Ack(response.ThroughSequence); err != nil {
		t.Fatal(err)
	}
	retained, err := storage.Pull(0, 10, "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(retained.Samples) != 3 || retained.Samples[0].SequenceEnd != 1 || retained.HasMore {
		t.Fatalf("acknowledgment removed retained samples: %#v", retained)
	}
	status, err := storage.Status("test")
	if err != nil {
		t.Fatal(err)
	}
	if status.AckedSequence != 2 || status.PendingSamples != 3 {
		t.Fatalf("unexpected status: %#v", status)
	}
	if err := storage.Ack(100); err == nil {
		t.Fatal("expected an acknowledgment beyond the issued sequence to fail")
	}
}

func TestStoragePullNormalizesLegacyKubernetesConfigs(t *testing.T) {
	storage, err := OpenStorage(filepath.Join(t.TempDir(), "monitor.db"), 8*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	if _, err := storage.Append(testSnapshot(time.Now(), 0)); err != nil {
		t.Fatal(err)
	}
	var legacy map[string]interface{}
	encoded, err := json.Marshal(testSnapshot(time.Now(), 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy, "kubernetesConfigs")
	encoded, err = json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.db.Exec("UPDATE samples SET payload_json = ? WHERE sequence_end = 1", string(encoded)); err != nil {
		t.Fatal(err)
	}

	response, err := storage.Pull(0, 1, "test")
	if err != nil {
		t.Fatal(err)
	}
	if response.Samples[0].Payload.KubernetesConfigs == nil {
		t.Fatal("legacy Kubernetes configs were not normalized")
	}
	responseJSON, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(responseJSON), `"kubernetesConfigs":null`) {
		t.Fatalf("legacy response still contains null Kubernetes configs: %s", responseJSON)
	}
}

func TestStoragePrunesSamplesOlderThanThirtyDays(t *testing.T) {
	storage, err := OpenStorage(filepath.Join(t.TempDir(), "monitor.db"), 8*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	if _, err := storage.Append(testSnapshot(time.Now().Add(-31*24*time.Hour), 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Append(testSnapshot(time.Now(), 0)); err != nil {
		t.Fatal(err)
	}
	response, err := storage.Pull(0, 10, "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Samples) != 1 || response.Samples[0].SequenceEnd != 2 {
		t.Fatalf("unexpected retained samples: %#v", response.Samples)
	}
}

func TestStorageClearPreservesAgentAndSequence(t *testing.T) {
	storage, err := OpenStorage(filepath.Join(t.TempDir(), "monitor.db"), 8*1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	if _, err := storage.Append(testSnapshot(time.Now(), 0)); err != nil {
		t.Fatal(err)
	}
	before, err := storage.Status("test")
	if err != nil {
		t.Fatal(err)
	}
	cleared, err := storage.Clear()
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Samples != 1 || cleared.Gaps != 0 {
		t.Fatalf("unexpected clear result: %#v", cleared)
	}
	empty, err := storage.Status("test")
	if err != nil {
		t.Fatal(err)
	}
	if empty.PendingSamples != 0 || empty.LastCollectedAt != "" {
		t.Fatalf("clear left stale collection status: %#v", empty)
	}
	sequence, err := storage.Append(testSnapshot(time.Now().Add(time.Second), 0))
	if err != nil {
		t.Fatal(err)
	}
	after, err := storage.Status("test")
	if err != nil {
		t.Fatal(err)
	}
	if sequence != 2 || before.AgentID != after.AgentID || after.PendingSamples != 1 {
		t.Fatalf("clear reset monitor identity or sequence: before=%#v after=%#v sequence=%d", before, after, sequence)
	}
}

func TestStorageCompactsAndReportsDroppedRange(t *testing.T) {
	storage, err := OpenStorage(filepath.Join(t.TempDir(), "monitor.db"), 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	base := time.Now().Add(-24 * time.Hour)
	for index := 0; index < 80; index++ {
		if _, err := storage.Append(testSnapshot(base.Add(time.Duration(index)*30*time.Second), 24*1024)); err != nil {
			t.Fatal(err)
		}
	}
	status, err := storage.Status("test")
	if err != nil {
		t.Fatal(err)
	}
	if status.PendingBytes > 1024*1024 {
		t.Fatalf("buffer limit was not enforced: %d", status.PendingBytes)
	}
	response, err := storage.Pull(0, 1000, "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Samples) == 0 {
		t.Fatal("expected compacted samples")
	}
	var aggregated bool
	for _, sample := range response.Samples {
		if sample.ResolutionSeconds >= 60 && sample.Payload.SampleCount > 1 {
			aggregated = true
		}
	}
	if !aggregated {
		t.Fatal("expected at least one aggregated sample")
	}
}

func TestAggregateRowsPreservesPerformanceMetricsAndStableProcessIdentity(t *testing.T) {
	first := testSnapshot(time.Now().Add(-time.Minute), 0)
	first.Host.CPUUserPercent = 30
	first.Host.DiskReadBytesPerSecond = 100
	first.Host.CPUPressure = PressureSnapshot{SomeAvg10: 5}
	first.Host.TopProcesses = []ProcessSnapshot{{
		PID: 10, Name: "api", CPUUsedPercent: 20, MemoryBytes: 100,
		WorkloadProvider: "systemd", WorkloadID: "api.service", WorkloadName: "api",
	}}
	second := testSnapshot(time.Now(), 0)
	second.Host.CPUUserPercent = 50
	second.Host.DiskReadBytesPerSecond = 300
	second.Host.CPUPressure = PressureSnapshot{SomeAvg10: 15}
	second.Host.TopProcesses = []ProcessSnapshot{{
		PID: 20, Name: "api", CPUUsedPercent: 40, MemoryBytes: 300,
		WorkloadProvider: "systemd", WorkloadID: "api.service", WorkloadName: "api",
	}}
	result := aggregateRows([]compactedRow{
		{sequenceStart: 1, sequenceEnd: 1, collectedAtMillis: snapshotTime(first.CollectedAt).UnixMilli(), resolutionSeconds: 30, sampleCount: 1, payload: first},
		{sequenceStart: 2, sequenceEnd: 2, collectedAtMillis: snapshotTime(second.CollectedAt).UnixMilli(), resolutionSeconds: 30, sampleCount: 1, payload: second},
	}, 60)
	if result.payload.Host.CPUUserPercent != 40 || result.payload.Host.DiskReadBytesPerSecond != 200 || result.payload.Host.CPUPressure.SomeAvg10 != 10 {
		t.Fatalf("unexpected performance aggregation: %#v", result.payload.Host)
	}
	if len(result.payload.Host.TopProcesses) != 1 || result.payload.Host.TopProcesses[0].PID != 20 || result.payload.Host.TopProcesses[0].CPUUsedPercent != 30 || result.payload.Host.TopProcesses[0].MemoryBytes != 200 {
		t.Fatalf("unexpected process aggregation: %#v", result.payload.Host.TopProcesses)
	}
}

func TestAggregateRowsSumsProcessesSharingStableIdentityWithinOneSample(t *testing.T) {
	snapshot := testSnapshot(time.Now(), 0)
	snapshot.Host.TopProcesses = []ProcessSnapshot{
		{PID: 10, Name: "worker", Executable: "worker", User: "app", CPUUsedPercent: 20, MemoryBytes: 100},
		{PID: 20, Name: "worker", Executable: "worker", User: "app", CPUUsedPercent: 30, MemoryBytes: 200},
	}
	result := aggregateRows([]compactedRow{{
		sequenceStart: 1, sequenceEnd: 1, collectedAtMillis: snapshotTime(snapshot.CollectedAt).UnixMilli(),
		resolutionSeconds: 30, sampleCount: 1, payload: snapshot,
	}}, 60)
	if len(result.payload.Host.TopProcesses) != 1 {
		t.Fatalf("expected one stable process series, got %#v", result.payload.Host.TopProcesses)
	}
	process := result.payload.Host.TopProcesses[0]
	if process.CPUUsedPercent != 50 || process.MemoryBytes != 300 {
		t.Fatalf("expected simultaneous processes to be summed, got %#v", process)
	}
}

func TestStorageRecordsGapWhenRecentSamplesCannotBeCompacted(t *testing.T) {
	storage, err := OpenStorage(filepath.Join(t.TempDir(), "monitor.db"), 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	base := time.Now().Add(-2 * time.Minute)
	for index := 0; index < 80; index++ {
		if _, err := storage.Append(testSnapshot(base.Add(time.Duration(index)*time.Second), 24*1024)); err != nil {
			t.Fatal(err)
		}
	}
	response, err := storage.Pull(0, 1000, "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Gaps) == 0 {
		t.Fatal("expected a sequence gap after dropping recent samples")
	}
	gap := response.Gaps[0]
	if gap.Reason != "local_buffer_limit" || gap.SequenceStart != 1 || gap.SequenceEnd < gap.SequenceStart {
		t.Fatalf("unexpected buffer gap: %#v", gap)
	}
	if response.OldestSequence != gap.SequenceStart {
		t.Fatalf("expected gap to preserve the oldest sequence, got %d", response.OldestSequence)
	}
}

func TestParseSize(t *testing.T) {
	value, err := parseSize("1.5MiB")
	if err != nil || value != 1572864 {
		t.Fatalf("unexpected parsed size %d: %v", value, err)
	}
	if _, err := parseSize("0"); err == nil {
		t.Fatal("expected zero size to fail")
	}
}
