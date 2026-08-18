package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
)

func TestLoadKubernetesSelectionsAndNormalizeWorkloadStatus(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	document := kubernetesSelectionDocument{
		Version: 1,
		Selections: []kubernetesSelection{
			{SourceID: strings.Repeat("a", 64), Context: "development"},
			{SourceID: strings.Repeat("a", 64), Context: "development"},
		},
	}
	content, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	selections, err := loadKubernetesSelections(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(selections) != 1 || selections[0].Context != "development" {
		t.Fatalf("unexpected selections: %#v", selections)
	}
	if status := replicaWorkloadStatus(3, 3, 3, 3, 0, 2, 2); status != StatusRunning {
		t.Fatalf("expected running workload, got %s", status)
	}
	if status := replicaWorkloadStatus(3, 2, 2, 2, 1, 2, 2); status != StatusDegraded {
		t.Fatalf("expected degraded workload, got %s", status)
	}
	if status := replicaWorkloadStatus(0, 0, 0, 0, 0, 2, 2); status != StatusStopped {
		t.Fatalf("expected stopped workload, got %s", status)
	}
	if status := daemonSetStatus(&appsv1.DaemonSet{Status: appsv1.DaemonSetStatus{DesiredNumberScheduled: 0}}); status != StatusDegraded {
		t.Fatalf("expected zero-node DaemonSet to be degraded, got %s", status)
	}
}

func TestAssociatedServicesRequiresNamespaceAndCompleteSelectorMatch(t *testing.T) {
	services := []corev1.Service{
		{Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "orders"}}},
		{Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "orders", "tier": "api"}}},
		{Spec: corev1.ServiceSpec{Selector: map[string]string{}}},
	}
	services[0].Name, services[0].Namespace = "orders", "production"
	services[1].Name, services[1].Namespace = "orders-api", "production"
	services[2].Name, services[2].Namespace = "headless", "production"
	matched := associatedServices(services, "production", map[string]string{"app": "orders", "tier": "worker"})
	if len(matched) != 1 || matched[0] != "orders" {
		t.Fatalf("unexpected associated services: %#v", matched)
	}
}
