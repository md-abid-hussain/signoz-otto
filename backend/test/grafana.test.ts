import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGrafanaDashboard } from '../src/ingest/grafana.js';

const samplePath = fileURLToPath(new URL('../../samples/spanmetrics-dashboard.json', import.meta.url));
const raw = JSON.parse(readFileSync(samplePath, 'utf-8'));

describe('parseGrafanaDashboard — spanmetrics sample', () => {
  const d = parseGrafanaDashboard(raw);

  it('extracts the title', () => {
    expect(d.title).toBe('Spanmetrics Demo Dashboard');
  });

  it('separates query panels from structural (text/row) panels', () => {
    // 7 query panels (from FLOW-NOTES run 2); text banner + 3 row headers are structural
    expect(d.panels.length).toBe(7);
    expect(d.structural.length).toBeGreaterThanOrEqual(3);
  });

  it('captures raw PromQL on every target, none empty', () => {
    for (const p of d.panels) {
      expect(p.targets.length).toBeGreaterThan(0);
      for (const t of p.targets) expect(t.expr.length).toBeGreaterThan(0);
    }
  });

  it('finds the two template variables', () => {
    expect(d.variables.map((v) => v.name).sort()).toEqual(['service', 'span_name']);
  });

  it('discovers the span-metrics dependencies (metrics + labels)', () => {
    expect(d.dependencies.metrics).toContain('traces_span_metrics_calls_total');
    expect(d.dependencies.metrics).toContain('traces_span_metrics_duration_milliseconds_bucket');
    expect(d.dependencies.labels).toContain('service_name');
    expect(d.dependencies.labels).toContain('status_code');
  });

  it('does not misclassify label keys as metrics', () => {
    expect(d.dependencies.metrics).not.toContain('service_name');
    expect(d.dependencies.metrics).not.toContain('span_name');
    // only the 4 real span-metric families remain
    expect(d.dependencies.metrics.length).toBe(4);
  });

  it('carries unit metadata through (ms / reqps panels)', () => {
    const units = new Set(d.panels.map((p) => p.unit).filter(Boolean));
    expect(units.size).toBeGreaterThan(0);
  });
});
