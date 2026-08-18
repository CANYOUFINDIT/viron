package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

const storageSchema = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS samples (
  sequence_start INTEGER NOT NULL,
  sequence_end INTEGER PRIMARY KEY,
  collected_at_ms INTEGER NOT NULL,
  resolution_seconds INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_collected_idx ON samples(collected_at_ms, resolution_seconds);
CREATE TABLE IF NOT EXISTS sequence_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_start INTEGER NOT NULL,
  sequence_end INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sequence_gaps_sequence_idx ON sequence_gaps(sequence_end);
`

const localRetention = 30 * 24 * time.Hour

type Storage struct {
	db       *sql.DB
	path     string
	maxBytes int64
	agentID  string
}

type compactedRow struct {
	sequenceStart     int64
	sequenceEnd       int64
	collectedAtMillis int64
	resolutionSeconds int
	sampleCount       int
	payload           CollectionSnapshot
}

type processAggregate struct {
	process ProcessSnapshot
	weight  int
}

func OpenStorage(path string, maxBytes int64) (*Storage, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	if maxBytes < 1024*1024 {
		return nil, errors.New("maximum buffer size must be at least 1 MiB")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("creating data directory: %w", err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=foreign_keys(ON)&_pragma=auto_vacuum(INCREMENTAL)")
	if err != nil {
		return nil, fmt.Errorf("opening monitor database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(storageSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initializing monitor database: %w", err)
	}
	storage := &Storage{db: db, path: path, maxBytes: maxBytes}
	agentID, err := storage.metadata("agent_id")
	if err != nil {
		storage.Close()
		return nil, err
	}
	if agentID == "" {
		agentID, err = randomID()
		if err != nil {
			storage.Close()
			return nil, err
		}
		if err := storage.setMetadata("agent_id", agentID); err != nil {
			storage.Close()
			return nil, err
		}
	}
	storage.agentID = agentID
	return storage, nil
}

func (s *Storage) Close() error { return s.db.Close() }

func (s *Storage) Append(snapshot CollectionSnapshot) (int64, error) {
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return 0, fmt.Errorf("encoding snapshot: %w", err)
	}
	collected := snapshotTime(snapshot.CollectedAt)
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	next, err := metadataIntTx(tx, "next_sequence")
	if err != nil {
		return 0, err
	}
	if next < 1 {
		next = 1
	}
	if _, err := tx.Exec(`
		INSERT INTO samples (sequence_start, sequence_end, collected_at_ms, resolution_seconds, sample_count, payload_json)
		VALUES (?, ?, ?, ?, ?, ?)
	`, next, next, collected.UnixMilli(), max(1, snapshot.ResolutionSeconds), max(1, snapshot.SampleCount), string(payload)); err != nil {
		return 0, err
	}
	if err := setMetadataTx(tx, "next_sequence", strconv.FormatInt(next+1, 10)); err != nil {
		return 0, err
	}
	if err := setMetadataTx(tx, "last_collected_at", snapshot.CollectedAt); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	if err := s.pruneExpired(time.Now()); err != nil {
		return next, fmt.Errorf("snapshot stored but retention cleanup failed: %w", err)
	}
	if err := s.enforceLimit(); err != nil {
		return next, fmt.Errorf("snapshot stored but buffer compaction failed: %w", err)
	}
	return next, nil
}

func (s *Storage) Pull(after int64, limit int, agentVersion string) (PullResponse, error) {
	if after < 0 {
		return PullResponse{}, errors.New("after sequence cannot be negative")
	}
	limit = min(max(limit, 1), 1000)
	latest, oldest, err := s.sequenceBounds()
	if err != nil {
		return PullResponse{}, err
	}
	upper, err := s.pullBoundary(after, limit)
	if err != nil {
		return PullResponse{}, err
	}
	response := PullResponse{
		ProtocolVersion: protocolVersion,
		AgentID:         s.agentID,
		AgentVersion:    agentVersion,
		Hostname:        hostname(),
		OldestSequence:  oldest,
		LatestSequence:  latest,
		ThroughSequence: after,
		Samples:         []StoredSample{},
		Gaps:            []SequenceGap{},
	}
	if upper <= after {
		return response, nil
	}
	rows, err := s.db.Query(`
		SELECT sequence_start, sequence_end, collected_at_ms, resolution_seconds, payload_json
		FROM samples WHERE sequence_end > ? AND sequence_end <= ? ORDER BY sequence_end
	`, after, upper)
	if err != nil {
		return PullResponse{}, err
	}
	for rows.Next() {
		var sample StoredSample
		var collectedMillis int64
		var payload string
		if err := rows.Scan(&sample.SequenceStart, &sample.SequenceEnd, &collectedMillis, &sample.ResolutionSeconds, &payload); err != nil {
			rows.Close()
			return PullResponse{}, err
		}
		if err := json.Unmarshal([]byte(payload), &sample.Payload); err != nil {
			rows.Close()
			return PullResponse{}, fmt.Errorf("decoding stored sample %d: %w", sample.SequenceEnd, err)
		}
		normalizeCollectionSnapshot(&sample.Payload)
		sample.CollectedAt = time.UnixMilli(collectedMillis).UTC().Format(time.RFC3339Nano)
		response.Samples = append(response.Samples, sample)
	}
	if err := rows.Close(); err != nil {
		return PullResponse{}, err
	}
	gapRows, err := s.db.Query(`
		SELECT sequence_start, sequence_end, started_at_ms, ended_at_ms, reason
		FROM sequence_gaps WHERE sequence_end > ? AND sequence_end <= ? ORDER BY sequence_end
	`, after, upper)
	if err != nil {
		return PullResponse{}, err
	}
	for gapRows.Next() {
		var gap SequenceGap
		var startedMillis, endedMillis int64
		if err := gapRows.Scan(&gap.SequenceStart, &gap.SequenceEnd, &startedMillis, &endedMillis, &gap.Reason); err != nil {
			gapRows.Close()
			return PullResponse{}, err
		}
		gap.StartedAt = time.UnixMilli(startedMillis).UTC().Format(time.RFC3339Nano)
		gap.EndedAt = time.UnixMilli(endedMillis).UTC().Format(time.RFC3339Nano)
		response.Gaps = append(response.Gaps, gap)
	}
	if err := gapRows.Close(); err != nil {
		return PullResponse{}, err
	}
	response.ThroughSequence = upper
	if err := s.db.QueryRow(`
		SELECT EXISTS(
			SELECT 1 FROM samples WHERE sequence_end > ?
			UNION ALL
			SELECT 1 FROM sequence_gaps WHERE sequence_end > ?
			LIMIT 1
		)
	`, upper, upper).Scan(&response.HasMore); err != nil {
		return PullResponse{}, err
	}
	return response, nil
}

func (s *Storage) Ack(through int64) error {
	if through < 0 {
		return errors.New("acknowledgment sequence cannot be negative")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	acked, err := metadataIntTx(tx, "acked_sequence")
	if err != nil {
		return err
	}
	if through < acked {
		through = acked
	}
	next, err := metadataIntTx(tx, "next_sequence")
	if err != nil {
		return err
	}
	if next <= 0 || through >= next {
		return fmt.Errorf("acknowledgment sequence %d was never issued", through)
	}
	if err := setMetadataTx(tx, "acked_sequence", strconv.FormatInt(through, 10)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}

func (s *Storage) Clear() (ClearResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return ClearResult{}, err
	}
	defer tx.Rollback()
	samples, err := tx.Exec("DELETE FROM samples")
	if err != nil {
		return ClearResult{}, err
	}
	gaps, err := tx.Exec("DELETE FROM sequence_gaps")
	if err != nil {
		return ClearResult{}, err
	}
	if _, err := tx.Exec("DELETE FROM metadata WHERE key = 'last_collected_at'"); err != nil {
		return ClearResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ClearResult{}, err
	}
	sampleCount, _ := samples.RowsAffected()
	gapCount, _ := gaps.RowsAffected()
	_, _ = s.db.Exec("PRAGMA incremental_vacuum(1024)")
	_, _ = s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	return ClearResult{Samples: sampleCount, Gaps: gapCount}, nil
}

func (s *Storage) Status(agentVersion string) (AgentStatus, error) {
	latest, oldest, err := s.sequenceBounds()
	if err != nil {
		return AgentStatus{}, err
	}
	acked, err := s.metadataInt("acked_sequence")
	if err != nil {
		return AgentStatus{}, err
	}
	var pending, pendingBytes int64
	if err := s.db.QueryRow("SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) FROM samples").Scan(&pending, &pendingBytes); err != nil {
		return AgentStatus{}, err
	}
	lastCollected, err := s.metadata("last_collected_at")
	if err != nil {
		return AgentStatus{}, err
	}
	return AgentStatus{
		ProtocolVersion: protocolVersion,
		AgentID:         s.agentID,
		AgentVersion:    agentVersion,
		Hostname:        hostname(),
		DatabasePath:    s.path,
		OldestSequence:  oldest,
		LatestSequence:  latest,
		AckedSequence:   acked,
		PendingSamples:  pending,
		PendingBytes:    pendingBytes,
		LastCollectedAt: lastCollected,
	}, nil
}

func (s *Storage) pullBoundary(after int64, limit int) (int64, error) {
	var upper sql.NullInt64
	err := s.db.QueryRow(`
		SELECT sequence_end FROM (
			SELECT sequence_end FROM samples WHERE sequence_end > ?
			UNION ALL
			SELECT sequence_end FROM sequence_gaps WHERE sequence_end > ?
		) pending ORDER BY sequence_end LIMIT 1 OFFSET ?
	`, after, after, limit-1).Scan(&upper)
	if errors.Is(err, sql.ErrNoRows) {
		var latest sql.NullInt64
		if err := s.db.QueryRow(`
			SELECT MAX(sequence_end) FROM (
				SELECT sequence_end FROM samples WHERE sequence_end > ?
				UNION ALL
				SELECT sequence_end FROM sequence_gaps WHERE sequence_end > ?
			) pending
		`, after, after).Scan(&latest); err != nil {
			return 0, err
		}
		if latest.Valid {
			return latest.Int64, nil
		}
		return after, nil
	}
	if err != nil {
		return 0, err
	}
	return upper.Int64, nil
}

func (s *Storage) sequenceBounds() (latest int64, oldest int64, err error) {
	err = s.db.QueryRow(`
		SELECT COALESCE(MAX(sequence_end), 0), COALESCE(MIN(sequence_start), 0) FROM (
			SELECT sequence_start, sequence_end FROM samples
			UNION ALL
			SELECT sequence_start, sequence_end FROM sequence_gaps
		)
	`).Scan(&latest, &oldest)
	return
}

func (s *Storage) enforceLimit() error {
	bytes, err := s.pendingBytes()
	if err != nil || bytes <= s.maxBytes {
		return err
	}
	for attempt := 0; attempt < 20 && bytes > s.maxBytes; attempt++ {
		changed, err := s.compactLevel(60, time.Now().Add(-10*time.Minute), 60)
		if err != nil {
			return err
		}
		if !changed {
			break
		}
		bytes, err = s.pendingBytes()
		if err != nil {
			return err
		}
	}
	for attempt := 0; attempt < 20 && bytes > s.maxBytes; attempt++ {
		changed, err := s.compactLevel(3600, time.Now().Add(-6*time.Hour), 3600)
		if err != nil {
			return err
		}
		if !changed {
			break
		}
		bytes, err = s.pendingBytes()
		if err != nil {
			return err
		}
	}
	if bytes > s.maxBytes {
		return s.dropOldest(bytes - (s.maxBytes * 9 / 10))
	}
	return nil
}

func (s *Storage) pruneExpired(now time.Time) error {
	cutoff := now.Add(-localRetention).UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM samples WHERE collected_at_ms < ?", cutoff); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM sequence_gaps WHERE ended_at_ms < ?", cutoff); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Storage) compactLevel(targetResolution int, olderThan time.Time, bucketSeconds int64) (bool, error) {
	operator := "<"
	if targetResolution == 3600 {
		operator = "<"
	}
	rows, err := s.db.Query(fmt.Sprintf(`
		SELECT sequence_start, sequence_end, collected_at_ms, resolution_seconds, sample_count, payload_json
		FROM samples WHERE resolution_seconds %s ? AND collected_at_ms < ?
		ORDER BY collected_at_ms LIMIT 1000
	`, operator), targetResolution, olderThan.UnixMilli())
	if err != nil {
		return false, err
	}
	groups := make(map[int64][]compactedRow)
	order := []int64{}
	for rows.Next() {
		var row compactedRow
		var payload string
		if err := rows.Scan(&row.sequenceStart, &row.sequenceEnd, &row.collectedAtMillis, &row.resolutionSeconds, &row.sampleCount, &payload); err != nil {
			rows.Close()
			return false, err
		}
		if err := json.Unmarshal([]byte(payload), &row.payload); err != nil {
			rows.Close()
			return false, err
		}
		normalizeCollectionSnapshot(&row.payload)
		bucket := row.collectedAtMillis / (bucketSeconds * 1000)
		if _, exists := groups[bucket]; !exists {
			order = append(order, bucket)
		}
		groups[bucket] = append(groups[bucket], row)
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	for _, bucket := range order {
		group := groups[bucket]
		if len(group) < 2 {
			continue
		}
		aggregated := aggregateRows(group, targetResolution)
		payload, err := json.Marshal(aggregated.payload)
		if err != nil {
			return false, err
		}
		tx, err := s.db.Begin()
		if err != nil {
			return false, err
		}
		for _, row := range group {
			if _, err := tx.Exec("DELETE FROM samples WHERE sequence_end = ?", row.sequenceEnd); err != nil {
				tx.Rollback()
				return false, err
			}
		}
		if _, err := tx.Exec(`
			INSERT INTO samples (sequence_start, sequence_end, collected_at_ms, resolution_seconds, sample_count, payload_json)
			VALUES (?, ?, ?, ?, ?, ?)
		`, aggregated.sequenceStart, aggregated.sequenceEnd, aggregated.collectedAtMillis, targetResolution, aggregated.sampleCount, string(payload)); err != nil {
			tx.Rollback()
			return false, err
		}
		if err := tx.Commit(); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

func normalizeCollectionSnapshot(snapshot *CollectionSnapshot) {
	if snapshot.KubernetesConfigs == nil {
		snapshot.KubernetesConfigs = []KubernetesConfigDiscovery{}
	}
	if snapshot.Host.TopProcesses == nil {
		snapshot.Host.TopProcesses = []ProcessSnapshot{}
	}
}

func aggregateRows(rows []compactedRow, resolution int) compactedRow {
	sort.Slice(rows, func(left, right int) bool { return rows[left].sequenceEnd < rows[right].sequenceEnd })
	result := rows[len(rows)-1]
	result.sequenceStart = rows[0].sequenceStart
	result.resolutionSeconds = resolution
	result.sampleCount = 0
	var cpu, cpuUser, cpuSystem, cpuIOWait, cpuSteal, load1, load5, load15, memory, swap float64
	var swapIn, swapOut, diskReadBytes, diskWriteBytes, diskReadOps, diskWriteOps float64
	var networkReceiveBytes, networkTransmitBytes, networkReceiveErrors, networkTransmitErrors float64
	var networkReceiveDrops, networkTransmitDrops float64
	var cpuPressure, memoryPressure, ioPressure PressureSnapshot
	processes := make(map[string]*processAggregate)
	for _, row := range rows {
		weight := max(1, row.sampleCount)
		result.sampleCount += weight
		cpu += row.payload.Host.CPUUsedPercent * float64(weight)
		cpuUser += row.payload.Host.CPUUserPercent * float64(weight)
		cpuSystem += row.payload.Host.CPUSystemPercent * float64(weight)
		cpuIOWait += row.payload.Host.CPUIOWaitPercent * float64(weight)
		cpuSteal += row.payload.Host.CPUStealPercent * float64(weight)
		load1 += row.payload.Host.Load1 * float64(weight)
		load5 += row.payload.Host.Load5 * float64(weight)
		load15 += row.payload.Host.Load15 * float64(weight)
		memory += row.payload.Host.MemoryUsedPercent * float64(weight)
		swap += row.payload.Host.SwapUsedPercent * float64(weight)
		swapIn += row.payload.Host.SwapInBytesPerSecond * float64(weight)
		swapOut += row.payload.Host.SwapOutBytesPerSecond * float64(weight)
		diskReadBytes += row.payload.Host.DiskReadBytesPerSecond * float64(weight)
		diskWriteBytes += row.payload.Host.DiskWriteBytesPerSecond * float64(weight)
		diskReadOps += row.payload.Host.DiskReadOpsPerSecond * float64(weight)
		diskWriteOps += row.payload.Host.DiskWriteOpsPerSecond * float64(weight)
		networkReceiveBytes += row.payload.Host.NetworkReceiveBytesPerSecond * float64(weight)
		networkTransmitBytes += row.payload.Host.NetworkTransmitBytesPerSecond * float64(weight)
		networkReceiveErrors += row.payload.Host.NetworkReceiveErrorsPerSecond * float64(weight)
		networkTransmitErrors += row.payload.Host.NetworkTransmitErrorsPerSecond * float64(weight)
		networkReceiveDrops += row.payload.Host.NetworkReceiveDropsPerSecond * float64(weight)
		networkTransmitDrops += row.payload.Host.NetworkTransmitDropsPerSecond * float64(weight)
		accumulatePressure(&cpuPressure, row.payload.Host.CPUPressure, weight)
		accumulatePressure(&memoryPressure, row.payload.Host.MemoryPressure, weight)
		accumulatePressure(&ioPressure, row.payload.Host.IOPressure, weight)
		rowProcesses := make(map[string]ProcessSnapshot)
		for _, process := range row.payload.Host.TopProcesses {
			key := processIdentity(process)
			current := rowProcesses[key]
			if current.PID == 0 {
				current = process
			} else {
				current.PID = process.PID
				current.CPUUsedPercent += process.CPUUsedPercent
				current.MemoryBytes += process.MemoryBytes
				current.DiskReadBytesPerSecond += process.DiskReadBytesPerSecond
				current.DiskWriteBytesPerSecond += process.DiskWriteBytesPerSecond
			}
			rowProcesses[key] = current
		}
		for key, process := range rowProcesses {
			current := processes[key]
			if current == nil {
				copy := process
				copy.CPUUsedPercent = 0
				copy.MemoryBytes = 0
				copy.DiskReadBytesPerSecond = 0
				copy.DiskWriteBytesPerSecond = 0
				current = &processAggregate{process: copy}
				processes[key] = current
			}
			current.weight += weight
			current.process.PID = process.PID
			current.process.CPUUsedPercent += process.CPUUsedPercent * float64(weight)
			current.process.MemoryBytes += process.MemoryBytes * uint64(weight)
			current.process.DiskReadBytesPerSecond += process.DiskReadBytesPerSecond * float64(weight)
			current.process.DiskWriteBytesPerSecond += process.DiskWriteBytesPerSecond * float64(weight)
		}
	}
	weight := float64(max(1, result.sampleCount))
	result.payload.Host.CPUUsedPercent = cpu / weight
	result.payload.Host.CPUUserPercent = cpuUser / weight
	result.payload.Host.CPUSystemPercent = cpuSystem / weight
	result.payload.Host.CPUIOWaitPercent = cpuIOWait / weight
	result.payload.Host.CPUStealPercent = cpuSteal / weight
	result.payload.Host.Load1 = load1 / weight
	result.payload.Host.Load5 = load5 / weight
	result.payload.Host.Load15 = load15 / weight
	result.payload.Host.MemoryUsedPercent = memory / weight
	result.payload.Host.SwapUsedPercent = swap / weight
	result.payload.Host.SwapInBytesPerSecond = swapIn / weight
	result.payload.Host.SwapOutBytesPerSecond = swapOut / weight
	result.payload.Host.DiskReadBytesPerSecond = diskReadBytes / weight
	result.payload.Host.DiskWriteBytesPerSecond = diskWriteBytes / weight
	result.payload.Host.DiskReadOpsPerSecond = diskReadOps / weight
	result.payload.Host.DiskWriteOpsPerSecond = diskWriteOps / weight
	result.payload.Host.NetworkReceiveBytesPerSecond = networkReceiveBytes / weight
	result.payload.Host.NetworkTransmitBytesPerSecond = networkTransmitBytes / weight
	result.payload.Host.NetworkReceiveErrorsPerSecond = networkReceiveErrors / weight
	result.payload.Host.NetworkTransmitErrorsPerSecond = networkTransmitErrors / weight
	result.payload.Host.NetworkReceiveDropsPerSecond = networkReceiveDrops / weight
	result.payload.Host.NetworkTransmitDropsPerSecond = networkTransmitDrops / weight
	result.payload.Host.CPUPressure = averagePressure(cpuPressure, weight)
	result.payload.Host.MemoryPressure = averagePressure(memoryPressure, weight)
	result.payload.Host.IOPressure = averagePressure(ioPressure, weight)
	result.payload.Host.TopProcesses = compactedTopProcesses(processes)
	result.payload.ResolutionSeconds = resolution
	result.payload.SampleCount = result.sampleCount
	result.payload.CollectedAt = time.UnixMilli(result.collectedAtMillis).UTC().Format(time.RFC3339Nano)
	return result
}

func accumulatePressure(target *PressureSnapshot, value PressureSnapshot, weight int) {
	factor := float64(weight)
	target.SomeAvg10 += value.SomeAvg10 * factor
	target.SomeAvg60 += value.SomeAvg60 * factor
	target.SomeAvg300 += value.SomeAvg300 * factor
	target.FullAvg10 += value.FullAvg10 * factor
	target.FullAvg60 += value.FullAvg60 * factor
	target.FullAvg300 += value.FullAvg300 * factor
}

func averagePressure(value PressureSnapshot, weight float64) PressureSnapshot {
	return PressureSnapshot{
		SomeAvg10: value.SomeAvg10 / weight, SomeAvg60: value.SomeAvg60 / weight, SomeAvg300: value.SomeAvg300 / weight,
		FullAvg10: value.FullAvg10 / weight, FullAvg60: value.FullAvg60 / weight, FullAvg300: value.FullAvg300 / weight,
	}
}

func processIdentity(process ProcessSnapshot) string {
	if process.WorkloadProvider != "" && process.WorkloadID != "" {
		return "workload:" + process.WorkloadProvider + ":" + process.WorkloadID
	}
	return "process:" + process.User + ":" + firstNonEmpty(process.Executable, process.Name)
}

func compactedTopProcesses(values map[string]*processAggregate) []ProcessSnapshot {
	processes := make([]ProcessSnapshot, 0, len(values))
	for _, value := range values {
		weight := float64(max(1, value.weight))
		value.process.CPUUsedPercent /= weight
		value.process.MemoryBytes = uint64(float64(value.process.MemoryBytes) / weight)
		value.process.DiskReadBytesPerSecond /= weight
		value.process.DiskWriteBytesPerSecond /= weight
		processes = append(processes, value.process)
	}
	selected := make(map[string]ProcessSnapshot)
	selectTop := func(read func(ProcessSnapshot) float64) {
		sorted := append([]ProcessSnapshot(nil), processes...)
		sort.Slice(sorted, func(left, right int) bool { return read(sorted[left]) > read(sorted[right]) })
		for _, process := range sorted[:min(5, len(sorted))] {
			selected[processIdentity(process)] = process
		}
	}
	selectTop(func(process ProcessSnapshot) float64 { return process.CPUUsedPercent })
	selectTop(func(process ProcessSnapshot) float64 { return float64(process.MemoryBytes) })
	selectTop(func(process ProcessSnapshot) float64 {
		return process.DiskReadBytesPerSecond + process.DiskWriteBytesPerSecond
	})
	result := make([]ProcessSnapshot, 0, len(selected))
	for _, process := range selected {
		result = append(result, process)
	}
	sort.Slice(result, func(left, right int) bool { return result[left].CPUUsedPercent > result[right].CPUUsedPercent })
	return result
}

func (s *Storage) dropOldest(bytesToDrop int64) error {
	rows, err := s.db.Query(`
		SELECT sequence_start, sequence_end, collected_at_ms, LENGTH(payload_json)
		FROM samples ORDER BY sequence_end
	`)
	if err != nil {
		return err
	}
	var starts, ends, collected []int64
	var removed int64
	for rows.Next() && removed < bytesToDrop {
		var start, end, at, length int64
		if err := rows.Scan(&start, &end, &at, &length); err != nil {
			rows.Close()
			return err
		}
		starts = append(starts, start)
		ends = append(ends, end)
		collected = append(collected, at)
		removed += length
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(ends) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, end := range ends {
		if _, err := tx.Exec("DELETE FROM samples WHERE sequence_end = ?", end); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`
		INSERT INTO sequence_gaps (sequence_start, sequence_end, started_at_ms, ended_at_ms, reason)
		VALUES (?, ?, ?, ?, 'local_buffer_limit')
	`, starts[0], ends[len(ends)-1], collected[0], collected[len(collected)-1]); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Storage) pendingBytes() (int64, error) {
	var bytes int64
	err := s.db.QueryRow("SELECT COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) FROM samples").Scan(&bytes)
	return bytes, err
}

func (s *Storage) metadata(key string) (string, error) {
	var value string
	err := s.db.QueryRow("SELECT value FROM metadata WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}

func (s *Storage) metadataInt(key string) (int64, error) {
	value, err := s.metadata(key)
	if err != nil || value == "" {
		return 0, err
	}
	return strconv.ParseInt(value, 10, 64)
}

func (s *Storage) setMetadata(key, value string) error {
	_, err := s.db.Exec(`
		INSERT INTO metadata (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`, key, value)
	return err
}

func metadataIntTx(tx *sql.Tx, key string) (int64, error) {
	var value string
	err := tx.QueryRow("SELECT value FROM metadata WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(value, 10, 64)
}

func setMetadataTx(tx *sql.Tx, key, value string) error {
	_, err := tx.Exec(`
		INSERT INTO metadata (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`, key, value)
	return err
}

func randomID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buffer)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

func hostname() string {
	value, err := os.Hostname()
	if err != nil {
		return ""
	}
	return value
}
