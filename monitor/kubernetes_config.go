package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const kubernetesSelectionVersion = 1

var kubernetesSourceIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type kubernetesSelection struct {
	SourceID string `json:"sourceId"`
	Context  string `json:"context"`
}

type kubernetesSelectionDocument struct {
	Version    int                   `json:"version"`
	Selections []kubernetesSelection `json:"selections"`
}

func configureKubernetes(dataDir, encoded string) error {
	if strings.TrimSpace(encoded) == "" {
		return errors.New("configure-kubernetes requires --selection-base64")
	}
	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return errors.New("invalid Kubernetes selection encoding")
	}
	if len(payload) > 64*1024 {
		return errors.New("Kubernetes selection payload is too large")
	}
	var document kubernetesSelectionDocument
	if err := json.Unmarshal(payload, &document); err != nil {
		return errors.New("invalid Kubernetes selection payload")
	}
	if document.Version != kubernetesSelectionVersion {
		return fmt.Errorf("unsupported Kubernetes selection version %d", document.Version)
	}
	if len(document.Selections) > 64 {
		return errors.New("no more than 64 Kubernetes contexts can be selected")
	}
	seen := make(map[string]bool, len(document.Selections))
	selections := make([]kubernetesSelection, 0, len(document.Selections))
	for _, selection := range document.Selections {
		selection.SourceID = strings.TrimSpace(selection.SourceID)
		selection.Context = strings.TrimSpace(selection.Context)
		if !kubernetesSourceIDPattern.MatchString(selection.SourceID) {
			return errors.New("invalid Kubernetes kubeconfig source identifier")
		}
		if selection.Context == "" || len(selection.Context) > 512 || strings.ContainsAny(selection.Context, "\x00\r\n") {
			return errors.New("invalid Kubernetes context name")
		}
		key := selection.SourceID + "\x00" + selection.Context
		if seen[key] {
			continue
		}
		seen[key] = true
		selections = append(selections, selection)
	}
	sort.Slice(selections, func(left, right int) bool {
		if selections[left].SourceID == selections[right].SourceID {
			return selections[left].Context < selections[right].Context
		}
		return selections[left].SourceID < selections[right].SourceID
	})
	document.Selections = selections

	if err := os.MkdirAll(dataDir, 0o770); err != nil {
		return fmt.Errorf("creating monitor data directory: %w", err)
	}
	temporary, err := os.CreateTemp(dataDir, ".kubernetes-selection.*")
	if err != nil {
		return fmt.Errorf("creating Kubernetes selection file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o640); err != nil {
		temporary.Close()
		return err
	}
	encoder := json.NewEncoder(temporary)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(document); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	target := filepath.Join(dataDir, "kubernetes-selection.json")
	if err := os.Rename(temporaryPath, target); err != nil {
		return fmt.Errorf("saving Kubernetes selection: %w", err)
	}
	return writeJSON(map[string]interface{}{"ok": true, "selectedContexts": len(selections)})
}
