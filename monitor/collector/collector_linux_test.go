//go:build linux

package main

import (
	"testing"
	"time"
)

func TestNormalizeMetricsCalculatesSwapUsageFromTelegrafFields(t *testing.T) {
	snapshot := normalizeMetrics([]capturedMetric{{
		Name: "mem",
		Fields: map[string]any{
			"total":        uint64(8_000),
			"used":         uint64(3_000),
			"used_percent": 37.5,
			"swap_total":   uint64(4_000),
			"swap_free":    uint64(1_000),
		},
	}}, nil, 30*time.Second)

	if snapshot.Host.SwapTotalBytes != 4_000 {
		t.Fatalf("expected swap total 4000, got %d", snapshot.Host.SwapTotalBytes)
	}
	if snapshot.Host.SwapUsedBytes != 3_000 {
		t.Fatalf("expected swap used 3000, got %d", snapshot.Host.SwapUsedBytes)
	}
	if snapshot.Host.SwapUsedPercent != 75 {
		t.Fatalf("expected swap usage 75%%, got %f", snapshot.Host.SwapUsedPercent)
	}
}

func TestNormalizeMetricsClampsInvalidSwapFreeValue(t *testing.T) {
	snapshot := normalizeMetrics([]capturedMetric{{
		Name: "mem",
		Fields: map[string]any{
			"swap_total": uint64(1_000),
			"swap_free":  uint64(2_000),
		},
	}}, nil, 30*time.Second)

	if snapshot.Host.SwapUsedBytes != 0 || snapshot.Host.SwapUsedPercent != 0 {
		t.Fatalf("expected invalid swap counters to clamp to zero, got %d bytes and %f%%", snapshot.Host.SwapUsedBytes, snapshot.Host.SwapUsedPercent)
	}
}
