// Readiness engine — the shared analyze stage (the "auditor inside").
// Resolves each Grafana-referenced metric against what actually exists in the
// live SigNoz instance: matched / renamed (with mapping) / missing. This is the
// ✅/🔄/❌ report + a per-panel status prediction.
//
// Rename heuristic (from FLOW-NOTES): a Prometheus metric name is the OTel name
// with dots→underscores, `_total` appended to counters, and the unit embedded
// (e.g. `_milliseconds`). We normalise both sides and match.

import type { ParsedDashboard } from '../ingest/grafana.js';
import type { PanelStatus, ReadinessItem, ReadinessReport } from '../types.js';
import type { SigNozMcp } from '../signoz/mcp.js';

const UNIT_TOKENS = /(milliseconds|nanoseconds|microseconds|seconds|bytes|ratio|percent|celsius|total)/g;

/** normalise a metric name for cross-naming comparison; keeps histogram parts (bucket/sum/count) */
export function normalizeMetric(name: string): string {
  return name.toLowerCase().replace(/[._]/g, ' ').replace(UNIT_TOKENS, ' ').replace(/\s+/g, '');
}

interface MetricRow { metricName: string }

export async function fetchInstanceMetrics(mcp: SigNozMcp): Promise<string[]> {
  const seen = new Set<string>();
  // a few stems widen coverage without needing an unbounded list
  for (const stem of ['', 'traces', 'signoz', 'http', 'span', 'duration', 'calls', 'k8s', 'system']) {
    const res = await mcp.call<{ data?: { metrics?: MetricRow[] } }>('list_metrics', {
      ...(stem ? { searchText: stem } : {}),
      timeRange: '7d',
      limit: 200,
    });
    for (const m of res?.data?.metrics ?? []) seen.add(m.metricName);
  }
  return [...seen];
}

function resolveMetric(dep: string, instance: string[], instanceNorm: Map<string, string>): ReadinessItem {
  if (instance.includes(dep)) return { name: dep, verdict: 'matched', panelsAffected: [] };
  const depNorm = normalizeMetric(dep);
  const hit = instanceNorm.get(depNorm);
  if (hit) {
    return {
      name: dep,
      verdict: 'renamed',
      mappedTo: hit,
      reason: `Prometheus→OTel naming (${dep} → ${hit})`,
      panelsAffected: [],
    };
  }
  return { name: dep, verdict: 'missing', reason: 'no metric with matching name in this instance', panelsAffected: [] };
}

export async function runReadiness(dash: ParsedDashboard, mcp: SigNozMcp): Promise<ReadinessReport> {
  const instance = await fetchInstanceMetrics(mcp);
  const instanceNorm = new Map<string, string>();
  for (const m of instance) if (!instanceNorm.has(normalizeMetric(m))) instanceNorm.set(normalizeMetric(m), m);

  // which panels reference which metric
  const panelsByMetric = new Map<string, Set<string>>();
  for (const p of dash.panels) {
    for (const t of p.targets) {
      for (const m of dash.dependencies.metrics) {
        if (t.expr.includes(m)) {
          if (!panelsByMetric.has(m)) panelsByMetric.set(m, new Set());
          panelsByMetric.get(m)!.add(p.id);
        }
      }
    }
  }

  const metrics = dash.dependencies.metrics.map((dep) => {
    const item = resolveMetric(dep, instance, instanceNorm);
    item.panelsAffected = [...(panelsByMetric.get(dep) ?? [])];
    return item;
  });

  const verdictByMetric = new Map(metrics.map((m) => [m.name, m.verdict]));

  // per-panel prediction: worst verdict among its metrics
  const perPanelPrediction: Record<string, PanelStatus> = {};
  for (const p of dash.panels) {
    const mset = metrics.filter((m) => m.panelsAffected.includes(p.id)).map((m) => m.verdict);
    let status: PanelStatus = 'validated';
    if (mset.includes('missing')) status = 'needs_review';
    else if (mset.includes('renamed')) status = 'validated_with_renames';
    perPanelPrediction[p.id] = status;
  }

  const summary = {
    matched: metrics.filter((m) => m.verdict === 'matched').length,
    renamed: metrics.filter((m) => m.verdict === 'renamed').length,
    missing: metrics.filter((m) => m.verdict === 'missing').length,
  };

  return { metrics, perPanelPrediction, summary };
}
