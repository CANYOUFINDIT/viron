package main

import (
	"encoding/json"
	"sort"
)

// Optional protocol v1 fields preserve extrema when local buffering is compacted.
// Old buffered averages cannot recover extrema that have already been discarded.
func snapshotMetricValues(snapshot CollectionSnapshot) map[string]map[string]float64 {
	encoded, _ := json.Marshal(snapshot)
	var document map[string]interface{}
	_ = json.Unmarshal(encoded, &document)
	result := make(map[string]map[string]float64)
	flatten := func(value map[string]interface{}) map[string]float64 {
		metrics := make(map[string]float64)
		for key, item := range value {
			if number, ok := item.(float64); ok {
				metrics[key] = number
			}
			if nested, ok := item.(map[string]interface{}); ok && (key == "cpuPressure" || key == "memoryPressure" || key == "ioPressure") {
				for field, item := range nested {
					if number, ok := item.(float64); ok {
						metrics[key+"."+field] = number
					}
				}
			}
		}
		return metrics
	}
	host, _ := document["host"].(map[string]interface{})
	result["host"] = flatten(host)
	for _, disk := range snapshot.Host.Disks {
		encoded, _ := json.Marshal(disk)
		var value map[string]interface{}
		_ = json.Unmarshal(encoded, &value)
		result["disk:"+disk.Path+":"+disk.Device] = flatten(value)
	}
	for _, temp := range snapshot.Host.Temperatures {
		encoded, _ := json.Marshal(temp)
		var value map[string]interface{}
		_ = json.Unmarshal(encoded, &value)
		result["temperature:"+temp.Chip+":"+temp.Feature] = flatten(value)
	}
	for _, candidate := range snapshot.Candidates {
		encoded, _ := json.Marshal(candidate)
		var value map[string]interface{}
		_ = json.Unmarshal(encoded, &value)
		metrics := flatten(value)
		delete(metrics, "pid")
		result["deployment:"+candidate.Provider+":"+candidate.ExternalID] = metrics
	}
	return result
}

func aggregateMetricStatistics(rows []compactedRow) (map[string]map[string]MetricStatistic, [][]int64) {
	statistics := make(map[string]map[string]MetricStatistic)
	coverage := make([][]int64, 0)
	for _, row := range rows {
		values := snapshotMetricValues(row.payload)
		for entity, metrics := range values {
			if statistics[entity] == nil {
				statistics[entity] = make(map[string]MetricStatistic)
			}
			for key, value := range metrics {
				weight := float64(max(1, row.resolutionSeconds))
				next := MetricStatistic{Sum: value * weight, Min: value, Max: value, Last: value, Weight: weight}
				if supplied, ok := row.payload.Statistics[entity][key]; ok && supplied.Weight > 0 {
					next = supplied
				}
				previous, ok := statistics[entity][key]
				if !ok {
					statistics[entity][key] = next
					continue
				}
				previous.Sum += next.Sum
				previous.Weight += next.Weight
				previous.Min = min(previous.Min, next.Min)
				previous.Max = max(previous.Max, next.Max)
				previous.Last = next.Last
				statistics[entity][key] = previous
			}
		}
		if len(row.payload.Coverage) > 0 {
			coverage = append(coverage, row.payload.Coverage...)
		} else {
			coverage = append(coverage, []int64{row.collectedAtMillis - int64(max(1, row.resolutionSeconds))*1000, row.collectedAtMillis})
		}
	}
	sort.Slice(coverage, func(i, j int) bool { return coverage[i][0] < coverage[j][0] })
	merged := make([][]int64, 0)
	for _, interval := range coverage {
		if len(merged) > 0 && interval[0] <= merged[len(merged)-1][1] {
			merged[len(merged)-1][1] = max(merged[len(merged)-1][1], interval[1])
		} else {
			merged = append(merged, []int64{interval[0], interval[1]})
		}
	}
	return statistics, merged
}
