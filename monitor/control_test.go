package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestControlSocketRunsOnlyFixedCollectionRequest(t *testing.T) {
	path := controlTestSocket(t)
	server, err := startControlServer(path)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	done := make(chan struct{})
	go func() {
		request := <-server.Requests()
		request.Respond(42, nil)
		close(done)
	}()
	response, err := requestCollection(path)
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.Sequence != 42 {
		t.Fatalf("unexpected response: %#v", response)
	}
	<-done

	connection, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := json.NewEncoder(connection).Encode(map[string]interface{}{"version": protocolVersion, "action": "shell", "command": "id"}); err != nil {
		t.Fatal(err)
	}
	var rejected controlResponse
	if err := json.NewDecoder(connection).Decode(&rejected); err != nil {
		t.Fatal(err)
	}
	if rejected.OK || rejected.Error == "" {
		t.Fatalf("unexpected rejection: %#v", rejected)
	}
}

func TestControlSocketDoesNotReplaceRegularFile(t *testing.T) {
	path := controlTestSocket(t)
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startControlServer(path); err == nil {
		t.Fatal("expected occupied control socket path to be rejected")
	}
}

func TestControlSocketDoesNotReplaceActiveDaemon(t *testing.T) {
	path := controlTestSocket(t)
	server, err := startControlServer(path)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	if _, err := startControlServer(path); err == nil {
		t.Fatal("expected active control socket to be preserved")
	}
	go func() {
		request := <-server.Requests()
		request.Respond(9, nil)
	}()
	response, err := requestCollection(path)
	if err != nil || response.Sequence != 9 {
		t.Fatalf("original control socket stopped working: %#v, %v", response, err)
	}
}

func TestCollectCommandDelegatesWithoutOpeningStorage(t *testing.T) {
	path := controlTestSocket(t)
	server, err := startControlServer(path)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go func() {
		request := <-server.Requests()
		request.Respond(7, nil)
	}()
	dataDir := t.TempDir()
	if err := run([]string{"collect", "--quiet", "--control-socket", path, "--data-dir", dataDir}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "monitor.db")); !os.IsNotExist(err) {
		t.Fatalf("collect command unexpectedly opened storage: %v", err)
	}
}

func controlTestSocket(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "viron-control-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return filepath.Join(directory, "control.sock")
}
