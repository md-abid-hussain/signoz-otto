import { describe, expect, it } from 'vitest';
import { normalizeMetric } from '../src/readiness/index.js';

describe('normalizeMetric — Prometheus↔OTel rename matching', () => {
  it('matches counter with _total dropped and dots↔underscores', () => {
    expect(normalizeMetric('traces_span_metrics_calls_total')).toBe(
      normalizeMetric('traces.span.metrics.calls'),
    );
  });

  it('matches histogram bucket with embedded unit token removed', () => {
    expect(normalizeMetric('traces_span_metrics_duration_milliseconds_bucket')).toBe(
      normalizeMetric('traces.span.metrics.duration.bucket'),
    );
  });

  it('keeps histogram parts distinct (bucket vs sum vs count)', () => {
    const bucket = normalizeMetric('traces_span_metrics_duration_milliseconds_bucket');
    const sum = normalizeMetric('traces_span_metrics_duration_milliseconds_sum');
    const count = normalizeMetric('traces_span_metrics_duration_milliseconds_count');
    expect(new Set([bucket, sum, count]).size).toBe(3);
  });

  it('does not collapse unrelated metrics', () => {
    expect(normalizeMetric('http_requests_total')).not.toBe(normalizeMetric('http_request_duration_seconds'));
  });
});
