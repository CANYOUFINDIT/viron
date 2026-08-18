package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

type runtimeOptions struct {
	dataDir                   string
	controlSocket             string
	interval                  time.Duration
	maxBytes                  int64
	database                  string
	kubernetesSelectionBase64 string
	quiet                     bool
	after                     int64
	through                   int64
	limit                     int
	showHelp                  bool
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.LUTC)
	if err := run(os.Args[1:]); err != nil {
		log.Printf("error: %v", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	command := "run"
	if len(arguments) > 0 && !strings.HasPrefix(arguments[0], "-") {
		command = arguments[0]
		arguments = arguments[1:]
	}
	if command == "help" || command == "--help" || command == "-h" {
		printUsage()
		return nil
	}
	if command == "version" {
		return writeJSON(map[string]interface{}{"name": "viron-monitor", "version": version, "protocolVersion": protocolVersion})
	}
	options, err := parseOptions(command, arguments)
	if err != nil {
		return err
	}
	if options.showHelp {
		printUsage()
		return nil
	}
	if command == "configure-kubernetes" {
		return configureKubernetes(options.dataDir, options.kubernetesSelectionBase64)
	}
	if command == "run" && os.Geteuid() != 0 {
		return errors.New("viron-monitor daemon must run as root")
	}
	if command == "collect" || command == "scan" {
		response, err := requestCollection(options.controlSocket)
		if err != nil {
			return err
		}
		if options.quiet {
			return nil
		}
		return writeJSON(response)
	}
	storage, err := OpenStorage(options.database, options.maxBytes)
	if err != nil {
		return err
	}
	defer storage.Close()

	switch command {
	case "run":
		return runDaemon(storage, options)
	case "pull":
		response, err := storage.Pull(options.after, options.limit, version)
		if err != nil {
			return err
		}
		return writeJSON(response)
	case "ack":
		if options.through <= 0 {
			return errors.New("ack requires --through with a positive sequence")
		}
		if err := storage.Ack(options.through); err != nil {
			return err
		}
		return writeJSON(map[string]interface{}{"ok": true, "throughSequence": options.through})
	case "clear":
		result, err := storage.Clear()
		if err != nil {
			return err
		}
		return writeJSON(map[string]interface{}{"ok": true, "cleared": result})
	case "status":
		status, err := storage.Status(version)
		if err != nil {
			return err
		}
		return writeJSON(status)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func parseOptions(command string, arguments []string) (runtimeOptions, error) {
	dataDir := firstNonEmpty(os.Getenv("VIRON_MONITOR_DATA_DIR"), "/var/lib/viron-monitor")
	controlSocket := firstNonEmpty(os.Getenv("VIRON_MONITOR_CONTROL_SOCKET"), "/run/viron-monitor/control.sock")
	intervalText := firstNonEmpty(os.Getenv("VIRON_MONITOR_INTERVAL"), "30s")
	interval, err := time.ParseDuration(intervalText)
	if err != nil {
		return runtimeOptions{}, fmt.Errorf("invalid VIRON_MONITOR_INTERVAL: %w", err)
	}
	maxBytes, err := parseSize(firstNonEmpty(os.Getenv("VIRON_MONITOR_MAX_BUFFER"), "256MiB"))
	if err != nil {
		return runtimeOptions{}, fmt.Errorf("invalid VIRON_MONITOR_MAX_BUFFER: %w", err)
	}
	options := runtimeOptions{dataDir: dataDir, controlSocket: controlSocket, interval: interval, maxBytes: maxBytes, limit: 200}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.StringVar(&options.dataDir, "data-dir", options.dataDir, "directory containing the local monitor database")
	flags.StringVar(&options.controlSocket, "control-socket", options.controlSocket, "local daemon control socket")
	flags.DurationVar(&options.interval, "interval", options.interval, "collection interval")
	flags.StringVar(&options.kubernetesSelectionBase64, "selection-base64", "", "base64-encoded Kubernetes context selection")
	maxBuffer := flags.String("max-buffer", firstNonEmpty(os.Getenv("VIRON_MONITOR_MAX_BUFFER"), "256MiB"), "maximum buffered payload size")
	flags.BoolVar(&options.quiet, "quiet", false, "suppress successful collect output")
	flags.Int64Var(&options.after, "after", 0, "pull samples after this previously consumed sequence")
	flags.Int64Var(&options.through, "through", 0, "acknowledge samples through this sequence")
	flags.IntVar(&options.limit, "limit", 200, "maximum samples and gaps returned by pull")
	flags.BoolVar(&options.showHelp, "help", false, "show usage")
	if err := flags.Parse(arguments); err != nil {
		return runtimeOptions{}, err
	}
	if flags.NArg() > 0 {
		return runtimeOptions{}, fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	options.maxBytes, err = parseSize(*maxBuffer)
	if err != nil {
		return runtimeOptions{}, err
	}
	if options.interval < 5*time.Second || options.interval > 24*time.Hour {
		return runtimeOptions{}, errors.New("collection interval must be between 5 seconds and 24 hours")
	}
	options.database = filepath.Join(options.dataDir, "monitor.db")
	return options, nil
}

func runDaemon(storage *Storage, options runtimeOptions) error {
	collector := NewCollector(options.dataDir)
	defer collector.Close()
	control, err := startControlServer(options.controlSocket)
	if err != nil {
		return err
	}
	defer control.Close()
	collect := func() (int64, error) {
		snapshot := collector.Collect(options.interval)
		sequence, err := storage.Append(snapshot)
		if err != nil {
			return 0, err
		}
		log.Printf("stored collection sequence %d with %d service candidates", sequence, len(snapshot.Candidates))
		return sequence, nil
	}
	if _, err := collect(); err != nil {
		log.Printf("collection failed: %v", err)
	}
	ticker := time.NewTicker(options.interval)
	defer ticker.Stop()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	for {
		select {
		case <-ticker.C:
			if _, err := collect(); err != nil {
				log.Printf("collection failed: %v", err)
			}
		case request := <-control.Requests():
			sequence, err := collect()
			request.Respond(sequence, err)
		case <-stop:
			return nil
		}
	}
}

func writeJSON(value interface{}) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func parseSize(value string) (int64, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, errors.New("size is required")
	}
	units := []struct {
		suffix     string
		multiplier int64
	}{
		{"GiB", 1024 * 1024 * 1024},
		{"MiB", 1024 * 1024},
		{"KiB", 1024},
		{"GB", 1000 * 1000 * 1000},
		{"MB", 1000 * 1000},
		{"KB", 1000},
		{"B", 1},
	}
	for _, unit := range units {
		if strings.HasSuffix(strings.ToUpper(trimmed), strings.ToUpper(unit.suffix)) {
			number := strings.TrimSpace(trimmed[:len(trimmed)-len(unit.suffix)])
			parsed, err := strconv.ParseFloat(number, 64)
			if err != nil || parsed <= 0 {
				return 0, fmt.Errorf("invalid size %q", value)
			}
			return int64(parsed * float64(unit.multiplier)), nil
		}
	}
	parsed, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("invalid size %q", value)
	}
	return parsed, nil
}

func printUsage() {
	fmt.Fprintln(os.Stderr, `viron-monitor stores Linux host and service observations in a local SQLite/WAL buffer.

Usage:
  viron-monitor run [--interval 30s] [--data-dir /var/lib/viron-monitor]
  viron-monitor collect [--quiet]
  viron-monitor scan
  viron-monitor configure-kubernetes --selection-base64 BASE64_JSON
  viron-monitor pull --after SEQUENCE [--limit 200]
  viron-monitor clear
  viron-monitor ack --through SEQUENCE  # compatibility command; does not delete data
  viron-monitor status
  viron-monitor version

Environment:
  VIRON_MONITOR_DATA_DIR
  VIRON_MONITOR_CONTROL_SOCKET
  VIRON_MONITOR_INTERVAL
  VIRON_MONITOR_MAX_BUFFER
  VIRON_MONITOR_KUBECONFIG_PATHS
  VIRON_MONITOR_PODMAN_ENDPOINTS
  VIRON_MONITOR_SUPERVISOR_URLS`)
}
