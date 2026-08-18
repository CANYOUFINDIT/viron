package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	interval := flag.Duration("interval", 30*time.Second, "collection interval used in snapshot metadata")
	flag.Parse()
	if flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "viron-monitor-collector does not accept positional arguments")
		os.Exit(2)
	}
	collector := NewCollector()
	defer collector.Close()
	if err := json.NewEncoder(os.Stdout).Encode(collector.Collect(*interval)); err != nil {
		fmt.Fprintf(os.Stderr, "encoding collection: %v\n", err)
		os.Exit(1)
	}
}
