package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	controlActionCollect = "collect"
	controlMessageLimit  = 1024
	controlDialTimeout   = 5 * time.Second
	controlCallTimeout   = 3 * time.Minute
)

type controlRequest struct {
	response chan controlResponse
}

func (request controlRequest) Respond(sequence int64, err error) {
	response := controlResponse{OK: err == nil, Sequence: sequence}
	if err != nil {
		response.Error = truncateControlError(err.Error())
	}
	request.response <- response
}

type controlRequestMessage struct {
	Version int    `json:"version"`
	Action  string `json:"action"`
}

type controlResponse struct {
	OK       bool   `json:"ok"`
	Sequence int64  `json:"sequence,omitempty"`
	Error    string `json:"error,omitempty"`
}

type controlServer struct {
	path     string
	listener net.Listener
	requests chan controlRequest
	done     chan struct{}
	close    sync.Once
	wait     sync.WaitGroup
}

func startControlServer(path string) (*controlServer, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("control socket path is required")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o770); err != nil {
		return nil, fmt.Errorf("creating control socket directory: %w", err)
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("control socket path is occupied by a non-socket file: %s", path)
		}
		if connection, dialErr := net.DialTimeout("unix", path, 200*time.Millisecond); dialErr == nil {
			connection.Close()
			return nil, fmt.Errorf("control socket is already active: %s", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("removing stale control socket: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("checking control socket: %w", err)
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listening on control socket: %w", err)
	}
	if err := os.Chmod(path, 0o660); err != nil {
		listener.Close()
		os.Remove(path)
		return nil, fmt.Errorf("securing control socket: %w", err)
	}
	server := &controlServer{
		path: path, listener: listener, requests: make(chan controlRequest), done: make(chan struct{}),
	}
	server.wait.Add(1)
	go server.accept()
	return server, nil
}

func (server *controlServer) Requests() <-chan controlRequest { return server.requests }

func (server *controlServer) Close() error {
	var closeErr error
	server.close.Do(func() {
		close(server.done)
		closeErr = server.listener.Close()
		server.wait.Wait()
		if err := os.Remove(server.path); err != nil && !errors.Is(err, os.ErrNotExist) && closeErr == nil {
			closeErr = err
		}
	})
	return closeErr
}

func (server *controlServer) accept() {
	defer server.wait.Done()
	for {
		connection, err := server.listener.Accept()
		if err != nil {
			select {
			case <-server.done:
				return
			default:
				continue
			}
		}
		server.wait.Add(1)
		go func() {
			defer server.wait.Done()
			server.handle(connection)
		}()
	}
}

func (server *controlServer) handle(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(controlDialTimeout))
	line, err := bufio.NewReader(io.LimitReader(connection, controlMessageLimit+1)).ReadBytes('\n')
	if err != nil || len(line) > controlMessageLimit {
		writeControlResponse(connection, controlResponse{Error: "invalid control request"})
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	var message controlRequestMessage
	if err := decoder.Decode(&message); err != nil {
		writeControlResponse(connection, controlResponse{Error: "invalid control request"})
		return
	}
	_ = connection.SetDeadline(time.Now().Add(controlCallTimeout))
	if message.Version != protocolVersion || message.Action != controlActionCollect || decoder.Decode(&struct{}{}) != io.EOF {
		writeControlResponse(connection, controlResponse{Error: "unsupported control request"})
		return
	}
	request := controlRequest{response: make(chan controlResponse, 1)}
	select {
	case server.requests <- request:
	case <-server.done:
		writeControlResponse(connection, controlResponse{Error: "monitor daemon is stopping"})
		return
	}
	select {
	case response := <-request.response:
		writeControlResponse(connection, response)
	case <-server.done:
		writeControlResponse(connection, controlResponse{Error: "monitor daemon is stopping"})
	}
}

func writeControlResponse(writer io.Writer, response controlResponse) {
	_ = json.NewEncoder(writer).Encode(response)
}

func requestCollection(path string) (controlResponse, error) {
	deadline := time.Now().Add(controlDialTimeout)
	var connection net.Conn
	var err error
	for {
		connection, err = net.DialTimeout("unix", path, 500*time.Millisecond)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return controlResponse{}, fmt.Errorf("connecting to root monitor daemon: %w", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(controlCallTimeout))
	if err := json.NewEncoder(connection).Encode(controlRequestMessage{Version: protocolVersion, Action: controlActionCollect}); err != nil {
		return controlResponse{}, fmt.Errorf("requesting root collection: %w", err)
	}
	var response controlResponse
	reader := bufio.NewReader(io.LimitReader(connection, controlMessageLimit))
	if err := json.NewDecoder(reader).Decode(&response); err != nil {
		return controlResponse{}, fmt.Errorf("reading root collection result: %w", err)
	}
	if !response.OK {
		return controlResponse{}, fmt.Errorf("root collection failed: %s", firstNonEmpty(response.Error, "unknown error"))
	}
	return response, nil
}

func truncateControlError(value string) string {
	const limit = 500
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
