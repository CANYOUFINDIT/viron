package main

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/influxdata/telegraf"
)

type capturedMetric struct {
	Name   string
	Tags   map[string]string
	Fields map[string]interface{}
	Time   time.Time
}

type metricAccumulator struct {
	mu      sync.Mutex
	metrics []capturedMetric
	errors  []error
}

type taggedAccumulator struct {
	target *metricAccumulator
	tags   map[string]string
}

func (a *metricAccumulator) add(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	if len(fields) == 0 {
		return
	}
	fieldCopy := make(map[string]interface{}, len(fields))
	for key, value := range fields {
		fieldCopy[key] = value
	}
	tagCopy := make(map[string]string, len(tags))
	for key, value := range tags {
		tagCopy[key] = value
	}
	metricTime := time.Now().UTC()
	if len(timestamps) > 0 {
		metricTime = timestamps[0].UTC()
	}
	a.mu.Lock()
	a.metrics = append(a.metrics, capturedMetric{Name: name, Tags: tagCopy, Fields: fieldCopy, Time: metricTime})
	a.mu.Unlock()
}

func (a *metricAccumulator) AddFields(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}

func (a *metricAccumulator) AddGauge(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}

func (a *metricAccumulator) AddCounter(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}

func (a *metricAccumulator) AddSummary(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}

func (a *metricAccumulator) AddHistogram(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}

func (a *metricAccumulator) AddMetric(metric telegraf.Metric) {
	a.addMetric(metric, nil)
}

func (a *metricAccumulator) addMetric(metric telegraf.Metric, extraTags map[string]string) {
	fields := make(map[string]interface{}, len(metric.FieldList()))
	for _, field := range metric.FieldList() {
		fields[field.Key] = field.Value
	}
	tags := make(map[string]string, len(metric.TagList()))
	for _, tag := range metric.TagList() {
		tags[tag.Key] = tag.Value
	}
	for key, value := range extraTags {
		tags[key] = value
	}
	a.add(metric.Name(), fields, tags, metric.Time())
}

func (*metricAccumulator) SetPrecision(time.Duration) {}

func (a *metricAccumulator) AddError(err error) {
	if err == nil {
		return
	}
	a.mu.Lock()
	a.errors = append(a.errors, err)
	a.mu.Unlock()
}

func (*metricAccumulator) WithTracking(int) telegraf.TrackingAccumulator {
	panic("viron-monitor does not request tracked metrics")
}

func (a *taggedAccumulator) add(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	merged := make(map[string]string, len(tags)+len(a.tags))
	for key, value := range tags {
		merged[key] = value
	}
	for key, value := range a.tags {
		merged[key] = value
	}
	a.target.add(name, fields, merged, timestamps...)
}

func (a *taggedAccumulator) AddFields(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}
func (a *taggedAccumulator) AddGauge(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}
func (a *taggedAccumulator) AddCounter(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}
func (a *taggedAccumulator) AddSummary(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}
func (a *taggedAccumulator) AddHistogram(name string, fields map[string]interface{}, tags map[string]string, timestamps ...time.Time) {
	a.add(name, fields, tags, timestamps...)
}
func (a *taggedAccumulator) AddMetric(metric telegraf.Metric) {
	a.target.addMetric(metric, a.tags)
}
func (*taggedAccumulator) SetPrecision(time.Duration) {}
func (a *taggedAccumulator) AddError(err error)       { a.target.AddError(err) }
func (*taggedAccumulator) WithTracking(int) telegraf.TrackingAccumulator {
	panic("viron-monitor does not request tracked metrics")
}

func (a *metricAccumulator) snapshot() ([]capturedMetric, []error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	metrics := append([]capturedMetric(nil), a.metrics...)
	errors := append([]error(nil), a.errors...)
	return metrics, errors
}

type pluginLogger struct {
	name       string
	attributes map[string]interface{}
}

func (l *pluginLogger) Level() telegraf.LogLevel { return telegraf.Warn }
func (l *pluginLogger) AddAttribute(key string, value interface{}) {
	if l.attributes == nil {
		l.attributes = make(map[string]interface{})
	}
	l.attributes[key] = value
}
func (l *pluginLogger) output(level, format string, args ...interface{}) {
	log.Printf("[%s] telegraf.%s: %s", level, l.name, fmt.Sprintf(format, args...))
}
func (l *pluginLogger) Errorf(format string, args ...interface{}) { l.output("error", format, args...) }
func (l *pluginLogger) Error(args ...interface{})                 { l.output("error", "%s", fmt.Sprint(args...)) }
func (l *pluginLogger) Warnf(format string, args ...interface{})  { l.output("warn", format, args...) }
func (l *pluginLogger) Warn(args ...interface{})                  { l.output("warn", "%s", fmt.Sprint(args...)) }
func (l *pluginLogger) Infof(string, ...interface{})              {}
func (l *pluginLogger) Info(...interface{})                       {}
func (l *pluginLogger) Debugf(string, ...interface{})             {}
func (l *pluginLogger) Debug(...interface{})                      {}
func (l *pluginLogger) Tracef(string, ...interface{})             {}
func (l *pluginLogger) Trace(...interface{})                      {}

func floatValue(value interface{}) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case int32:
		return float64(typed)
	case uint:
		return float64(typed)
	case uint64:
		return float64(typed)
	case uint32:
		return float64(typed)
	default:
		return 0
	}
}

func int64Value(value interface{}) int64 { return int64(floatValue(value)) }
func uint64Value(value interface{}) uint64 {
	converted := floatValue(value)
	if converted <= 0 {
		return 0
	}
	return uint64(converted)
}
