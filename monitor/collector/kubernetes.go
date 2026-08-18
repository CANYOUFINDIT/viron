package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

const (
	maximumKubeconfigFiles       = 64
	maximumKubeconfigFileSize    = 10 * 1024 * 1024
	maximumKubernetesDiscoveries = 900
	kubernetesScanTimeout        = 10 * time.Second
)

type kubernetesSelection struct {
	SourceID string `json:"sourceId"`
	Context  string `json:"context"`
}

type kubernetesSelectionDocument struct {
	Version    int                   `json:"version"`
	Selections []kubernetesSelection `json:"selections"`
}

type kubernetesScanTarget struct {
	discoveryIndex int
	path           string
}

type kubernetesScanResult struct {
	discoveryIndex int
	candidates     []ServiceCandidate
	status         string
	error          string
}

func collectKubernetes() ([]KubernetesConfigDiscovery, []ServiceCandidate, []string) {
	selectionFile := strings.TrimSpace(os.Getenv("VIRON_MONITOR_KUBERNETES_SELECTION_FILE"))
	selections, selectionError := loadKubernetesSelections(selectionFile)
	selected := make(map[string]bool, len(selections))
	for _, selection := range selections {
		selected[selection.SourceID+"\x00"+selection.Context] = true
	}

	discoveries := make([]KubernetesConfigDiscovery, 0)
	targets := make([]kubernetesScanTarget, 0)
	seenSelections := make(map[string]bool, len(selections))
	for _, path := range discoverKubeconfigPaths() {
		if len(discoveries) >= maximumKubernetesDiscoveries {
			break
		}
		sourceID := kubeconfigSourceID(path)
		info, err := os.Stat(path)
		if err != nil {
			if os.IsPermission(err) {
				discoveries = append(discoveries, KubernetesConfigDiscovery{
					SourceID: sourceID, Path: path, Status: "unreadable", Error: "viron-monitor 没有权限读取该 kubeconfig",
				})
			}
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if info.Size() > maximumKubeconfigFileSize {
			discoveries = append(discoveries, KubernetesConfigDiscovery{
				SourceID: sourceID, Path: path, Status: "invalid", Error: "kubeconfig 文件超过 10 MiB，已跳过",
			})
			continue
		}
		content, err := os.ReadFile(path)
		if err != nil {
			discoveries = append(discoveries, KubernetesConfigDiscovery{
				SourceID: sourceID, Path: path, Status: "unreadable", Error: safeKubernetesError(err),
			})
			continue
		}
		configuration, err := clientcmd.Load(content)
		if err != nil {
			discoveries = append(discoveries, KubernetesConfigDiscovery{
				SourceID: sourceID, Path: path, Status: "invalid", Error: safeKubernetesError(err),
			})
			continue
		}
		contextNames := make([]string, 0, len(configuration.Contexts))
		for contextName := range configuration.Contexts {
			contextNames = append(contextNames, contextName)
		}
		sort.Strings(contextNames)
		for _, contextName := range contextNames {
			if len(discoveries) >= maximumKubernetesDiscoveries {
				break
			}
			contextDetails := configuration.Contexts[contextName]
			if contextDetails == nil {
				continue
			}
			selectionKey := sourceID + "\x00" + contextName
			isSelected := selected[selectionKey]
			displayContext := contextName
			discovery := KubernetesConfigDiscovery{
				SourceID:       sourceID,
				Path:           path,
				Context:        displayContext,
				Cluster:        truncateKubernetesString(contextDetails.Cluster, 512),
				Namespace:      firstKubernetesNonEmpty(contextDetails.Namespace, "default"),
				CurrentContext: configuration.CurrentContext == contextName,
				Selected:       isSelected,
				Status:         "discovered",
			}
			if len(contextName) > 512 {
				discovery.Context = truncateKubernetesString(contextName, 512)
				discovery.Status = "invalid"
				discovery.Error = "context 名称超过 512 个字符，无法纳管"
			}
			if contextDetails.Cluster == "" || configuration.Clusters[contextDetails.Cluster] == nil {
				discovery.Status = "invalid"
				discovery.Error = "context 未引用有效的 cluster"
			}
			discoveries = append(discoveries, discovery)
			if isSelected {
				seenSelections[selectionKey] = true
				if discovery.Status != "invalid" {
					targets = append(targets, kubernetesScanTarget{discoveryIndex: len(discoveries) - 1, path: path})
				}
			}
		}
	}

	for _, selection := range selections {
		key := selection.SourceID + "\x00" + selection.Context
		if seenSelections[key] {
			continue
		}
		discoveries = append(discoveries, KubernetesConfigDiscovery{
			SourceID: selection.SourceID, Context: selection.Context, Selected: true, Status: "error",
			Error: "已选择的 kubeconfig 或 context 不再可用",
		})
	}

	errorsFound := make([]string, 0)
	if selectionError != nil {
		errorsFound = append(errorsFound, "Kubernetes 扫描配置无效："+safeKubernetesError(selectionError))
	}
	if len(targets) == 0 {
		sortKubernetesDiscoveries(discoveries)
		return discoveries, []ServiceCandidate{}, errorsFound
	}

	ctx, cancel := context.WithTimeout(context.Background(), kubernetesScanTimeout)
	defer cancel()
	results := make(chan kubernetesScanResult, len(targets))
	semaphore := make(chan struct{}, 4)
	var wait sync.WaitGroup
	for _, target := range targets {
		target := target
		wait.Add(1)
		go func() {
			defer wait.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				results <- kubernetesScanResult{discoveryIndex: target.discoveryIndex, status: "error", error: "Kubernetes 扫描超时"}
				return
			}
			discovery := discoveries[target.discoveryIndex]
			candidates, status, scanError := scanKubernetesContext(ctx, target.path, discovery)
			results <- kubernetesScanResult{discoveryIndex: target.discoveryIndex, candidates: candidates, status: status, error: scanError}
		}()
	}
	wait.Wait()
	close(results)
	candidates := make([]ServiceCandidate, 0)
	for result := range results {
		discoveries[result.discoveryIndex].Status = result.status
		discoveries[result.discoveryIndex].CandidateCount = len(result.candidates)
		discoveries[result.discoveryIndex].Error = result.error
		candidates = append(candidates, result.candidates...)
		if result.error != "" {
			discovery := discoveries[result.discoveryIndex]
			errorsFound = append(errorsFound, fmt.Sprintf("Kubernetes %s：%s", discovery.Context, result.error))
		}
	}
	sortKubernetesDiscoveries(discoveries)
	sort.Slice(candidates, func(left, right int) bool {
		leftMetadata := candidates[left].Metadata
		rightMetadata := candidates[right].Metadata
		leftKey := fmt.Sprint(leftMetadata["cluster"], "\x00", leftMetadata["context"], "\x00", leftMetadata["namespace"], "\x00", leftMetadata["resourceKind"], "\x00", candidates[left].Name)
		rightKey := fmt.Sprint(rightMetadata["cluster"], "\x00", rightMetadata["context"], "\x00", rightMetadata["namespace"], "\x00", rightMetadata["resourceKind"], "\x00", candidates[right].Name)
		return leftKey < rightKey
	})
	return discoveries, candidates, errorsFound
}

func discoverKubeconfigPaths() []string {
	paths := make([]string, 0)
	seen := make(map[string]bool)
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if strings.HasPrefix(value, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				value = filepath.Join(home, strings.TrimPrefix(value, "~/"))
			}
		}
		absolute, err := filepath.Abs(value)
		if err != nil {
			return
		}
		absolute = filepath.Clean(absolute)
		if seen[absolute] || len(paths) >= maximumKubeconfigFiles {
			return
		}
		seen[absolute] = true
		paths = append(paths, absolute)
	}
	addList := func(value string) {
		for _, item := range strings.FieldsFunc(value, func(character rune) bool {
			return character == ',' || character == rune(os.PathListSeparator)
		}) {
			add(item)
		}
	}
	addList(os.Getenv("KUBECONFIG"))
	addList(os.Getenv("VIRON_MONITOR_KUBECONFIG_PATHS"))
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".kube", "config"))
	}
	for _, path := range []string{
		"/etc/kubernetes/admin.conf",
		"/etc/rancher/k3s/k3s.yaml",
		"/etc/rancher/rke2/rke2.yaml",
		"/root/.kube/config",
	} {
		add(path)
	}
	if homeEntries, err := os.ReadDir("/home"); err == nil {
		for _, entry := range homeEntries {
			if entry.IsDir() {
				add(filepath.Join("/home", entry.Name(), ".kube", "config"))
			}
		}
	}
	sort.Strings(paths)
	return paths
}

func loadKubernetesSelections(path string) ([]kubernetesSelection, error) {
	if path == "" {
		return []kubernetesSelection{}, nil
	}
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return []kubernetesSelection{}, nil
	}
	if err != nil {
		return nil, err
	}
	var document kubernetesSelectionDocument
	if err := json.Unmarshal(content, &document); err != nil {
		return nil, err
	}
	if document.Version != 1 {
		return nil, fmt.Errorf("unsupported selection version %d", document.Version)
	}
	if len(document.Selections) > 64 {
		return nil, errors.New("too many selected Kubernetes contexts")
	}
	result := make([]kubernetesSelection, 0, len(document.Selections))
	seen := make(map[string]bool, len(document.Selections))
	for _, selection := range document.Selections {
		selection.SourceID = strings.TrimSpace(selection.SourceID)
		selection.Context = strings.TrimSpace(selection.Context)
		if len(selection.SourceID) != 64 || !isLowerHex(selection.SourceID) || selection.Context == "" || len(selection.Context) > 512 || strings.ContainsAny(selection.Context, "\x00\r\n") {
			return nil, errors.New("invalid selected Kubernetes context")
		}
		key := selection.SourceID + "\x00" + selection.Context
		if !seen[key] {
			seen[key] = true
			result = append(result, selection)
		}
	}
	return result, nil
}

func scanKubernetesContext(ctx context.Context, path string, discovery KubernetesConfigDiscovery) ([]ServiceCandidate, string, string) {
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: path}
	overrides := &clientcmd.ConfigOverrides{CurrentContext: discovery.Context}
	clientConfiguration, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides).ClientConfig()
	if err != nil {
		return []ServiceCandidate{}, "error", safeKubernetesError(err)
	}
	clientConfiguration.Timeout = 5 * time.Second
	clientConfiguration.UserAgent = "viron-monitor"
	clientset, err := kubernetes.NewForConfig(clientConfiguration)
	if err != nil {
		return []ServiceCandidate{}, "error", safeKubernetesError(err)
	}

	contextNamespace := firstKubernetesNonEmpty(discovery.Namespace, "default")
	var deployments *appsv1.DeploymentList
	var statefulSets *appsv1.StatefulSetList
	var daemonSets *appsv1.DaemonSetList
	var services *corev1.ServiceList
	type listFailure struct {
		resource string
		err      error
	}
	failures := make(chan listFailure, 4)
	var wait sync.WaitGroup
	wait.Add(4)
	go func() {
		defer wait.Done()
		var listError error
		deployments, listError = clientset.AppsV1().Deployments(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
		if apierrors.IsForbidden(listError) {
			deployments, listError = clientset.AppsV1().Deployments(contextNamespace).List(ctx, metav1.ListOptions{})
		}
		if listError != nil {
			failures <- listFailure{resource: "Deployment", err: listError}
		}
	}()
	go func() {
		defer wait.Done()
		var listError error
		statefulSets, listError = clientset.AppsV1().StatefulSets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
		if apierrors.IsForbidden(listError) {
			statefulSets, listError = clientset.AppsV1().StatefulSets(contextNamespace).List(ctx, metav1.ListOptions{})
		}
		if listError != nil {
			failures <- listFailure{resource: "StatefulSet", err: listError}
		}
	}()
	go func() {
		defer wait.Done()
		var listError error
		daemonSets, listError = clientset.AppsV1().DaemonSets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
		if apierrors.IsForbidden(listError) {
			daemonSets, listError = clientset.AppsV1().DaemonSets(contextNamespace).List(ctx, metav1.ListOptions{})
		}
		if listError != nil {
			failures <- listFailure{resource: "DaemonSet", err: listError}
		}
	}()
	go func() {
		defer wait.Done()
		var listError error
		services, listError = clientset.CoreV1().Services(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
		if apierrors.IsForbidden(listError) {
			services, listError = clientset.CoreV1().Services(contextNamespace).List(ctx, metav1.ListOptions{})
		}
		if listError != nil {
			failures <- listFailure{resource: "Service", err: listError}
		}
	}()
	wait.Wait()
	close(failures)
	failureMessages := make([]string, 0)
	for failure := range failures {
		failureMessages = append(failureMessages, failure.resource+": "+safeKubernetesError(failure.err))
	}
	sort.Strings(failureMessages)

	workloadListsSucceeded := 0
	if deployments != nil {
		workloadListsSucceeded++
	}
	if statefulSets != nil {
		workloadListsSucceeded++
	}
	if daemonSets != nil {
		workloadListsSucceeded++
	}
	if workloadListsSucceeded == 0 {
		return []ServiceCandidate{}, "error", strings.Join(failureMessages, "; ")
	}

	serviceItems := []corev1.Service{}
	if services != nil {
		serviceItems = services.Items
	}
	candidates := make([]ServiceCandidate, 0)
	if deployments != nil {
		for index := range deployments.Items {
			item := &deployments.Items[index]
			desired := int32(1)
			if item.Spec.Replicas != nil {
				desired = *item.Spec.Replicas
			}
			metadata := kubernetesCandidateMetadata(discovery, item.Namespace, "Deployment", desired, item.Status.ReadyReplicas, item.Status.AvailableReplicas, item.Status.UpdatedReplicas, item.Status.UnavailableReplicas, item.Generation, item.Status.ObservedGeneration, associatedServices(serviceItems, item.Namespace, item.Spec.Template.Labels))
			candidates = append(candidates, ServiceCandidate{
				Provider: "kubernetes", ExternalID: kubernetesExternalID(discovery.SourceID, discovery.Context, item.Namespace, "Deployment", item.Name),
				Name: item.Name, Group: kubernetesGroup(discovery.Context, item.Namespace), Status: replicaWorkloadStatus(desired, item.Status.ReadyReplicas, item.Status.AvailableReplicas, item.Status.UpdatedReplicas, item.Status.UnavailableReplicas, item.Generation, item.Status.ObservedGeneration),
				State: replicaState(item.Status.ReadyReplicas, desired, item.Status.UpdatedReplicas, item.Status.UnavailableReplicas), Metadata: metadata,
			})
		}
	}
	if statefulSets != nil {
		for index := range statefulSets.Items {
			item := &statefulSets.Items[index]
			desired := int32(1)
			if item.Spec.Replicas != nil {
				desired = *item.Spec.Replicas
			}
			metadata := kubernetesCandidateMetadata(discovery, item.Namespace, "StatefulSet", desired, item.Status.ReadyReplicas, item.Status.AvailableReplicas, item.Status.UpdatedReplicas, max(0, desired-item.Status.ReadyReplicas), item.Generation, item.Status.ObservedGeneration, associatedServices(serviceItems, item.Namespace, item.Spec.Template.Labels))
			candidates = append(candidates, ServiceCandidate{
				Provider: "kubernetes", ExternalID: kubernetesExternalID(discovery.SourceID, discovery.Context, item.Namespace, "StatefulSet", item.Name),
				Name: item.Name, Group: kubernetesGroup(discovery.Context, item.Namespace), Status: replicaWorkloadStatus(desired, item.Status.ReadyReplicas, item.Status.AvailableReplicas, item.Status.UpdatedReplicas, max(0, desired-item.Status.ReadyReplicas), item.Generation, item.Status.ObservedGeneration),
				State: replicaState(item.Status.ReadyReplicas, desired, item.Status.UpdatedReplicas, max(0, desired-item.Status.ReadyReplicas)), Metadata: metadata,
			})
		}
	}
	if daemonSets != nil {
		for index := range daemonSets.Items {
			item := &daemonSets.Items[index]
			desired := item.Status.DesiredNumberScheduled
			metadata := kubernetesCandidateMetadata(discovery, item.Namespace, "DaemonSet", desired, item.Status.NumberReady, item.Status.NumberAvailable, item.Status.UpdatedNumberScheduled, item.Status.NumberUnavailable, item.Generation, item.Status.ObservedGeneration, associatedServices(serviceItems, item.Namespace, item.Spec.Template.Labels))
			metadata["misscheduledReplicas"] = item.Status.NumberMisscheduled
			candidates = append(candidates, ServiceCandidate{
				Provider: "kubernetes", ExternalID: kubernetesExternalID(discovery.SourceID, discovery.Context, item.Namespace, "DaemonSet", item.Name),
				Name: item.Name, Group: kubernetesGroup(discovery.Context, item.Namespace), Status: daemonSetStatus(item),
				State: replicaState(item.Status.NumberReady, desired, item.Status.UpdatedNumberScheduled, item.Status.NumberUnavailable), Metadata: metadata,
			})
		}
	}
	return candidates, "connected", strings.Join(failureMessages, "; ")
}

func kubernetesCandidateMetadata(discovery KubernetesConfigDiscovery, namespace, resourceKind string, desired, ready, available, updated, unavailable int32, generation, observedGeneration int64, services []string) map[string]interface{} {
	return map[string]interface{}{
		"kubeconfigSourceId":  discovery.SourceID,
		"kubeconfigPath":      discovery.Path,
		"context":             discovery.Context,
		"cluster":             discovery.Cluster,
		"namespace":           namespace,
		"resourceKind":        resourceKind,
		"desiredReplicas":     desired,
		"readyReplicas":       ready,
		"availableReplicas":   available,
		"updatedReplicas":     updated,
		"unavailableReplicas": unavailable,
		"generation":          generation,
		"observedGeneration":  observedGeneration,
		"services":            services,
	}
}

func replicaWorkloadStatus(desired, ready, available, updated, unavailable int32, generation, observedGeneration int64) CandidateStatus {
	if desired == 0 {
		return StatusStopped
	}
	if ready >= desired && available >= desired && updated >= desired && unavailable == 0 && observedGeneration >= generation {
		return StatusRunning
	}
	return StatusDegraded
}

func daemonSetStatus(item *appsv1.DaemonSet) CandidateStatus {
	desired := item.Status.DesiredNumberScheduled
	if desired > 0 && item.Status.NumberReady >= desired && item.Status.NumberAvailable >= desired && item.Status.UpdatedNumberScheduled >= desired && item.Status.NumberUnavailable == 0 && item.Status.NumberMisscheduled == 0 && item.Status.ObservedGeneration >= item.Generation {
		return StatusRunning
	}
	return StatusDegraded
}

func replicaState(ready, desired, updated, unavailable int32) string {
	return fmt.Sprintf("%d/%d ready · %d updated · %d unavailable", ready, desired, updated, unavailable)
}

func associatedServices(services []corev1.Service, namespace string, workloadLabels map[string]string) []string {
	result := make([]string, 0)
	for index := range services {
		service := &services[index]
		if service.Namespace != namespace || len(service.Spec.Selector) == 0 {
			continue
		}
		matches := true
		for key, value := range service.Spec.Selector {
			if workloadLabels[key] != value {
				matches = false
				break
			}
		}
		if matches {
			result = append(result, service.Name)
		}
	}
	sort.Strings(result)
	return result
}

func kubernetesExternalID(sourceID, contextName, namespace, resourceKind, name string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{sourceID, contextName, namespace, resourceKind, name}, "\x00")))
	return "k8s:" + hex.EncodeToString(sum[:])
}

func kubeconfigSourceID(path string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(path)))
	return hex.EncodeToString(sum[:])
}

func sortKubernetesDiscoveries(discoveries []KubernetesConfigDiscovery) {
	sort.Slice(discoveries, func(left, right int) bool {
		leftKey := discoveries[left].Path + "\x00" + discoveries[left].Context
		rightKey := discoveries[right].Path + "\x00" + discoveries[right].Context
		return leftKey < rightKey
	})
}

func safeKubernetesError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.ReplaceAll(err.Error(), "\n", " ")
	message = strings.ReplaceAll(message, "\r", " ")
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

func firstKubernetesNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func kubernetesGroup(contextName, namespace string) string {
	return truncateKubernetesString(contextName+"/"+namespace, 255)
}

func truncateKubernetesString(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func isLowerHex(value string) bool {
	_, err := hex.DecodeString(value)
	return err == nil && strings.ToLower(value) == value
}
