// Translate + validate: the deterministic heart of the migration playbook.
// Per panel target: mapPromql → apply metric renames (readiness) + label Prom→OTel
// rename + resolve fieldContext per key (F4) → build a v5 execute_builder_query
// payload → validate live (200 + non-null aggregations = PASS; F2/F4). Failures
// (e.g. histogram-bucket percentile 500s, F5) are classified, never silently dropped.

import { mapPromql } from '../mapper/promql.js';
import type { ParsedDashboard } from '../ingest/grafana.js';
import type { GrafanaTarget, ReadinessReport } from '../types.js';
import type { SigNozMcp } from '../signoz/mcp.js';

export interface ResolvedQuery {
  metricName: string;
  timeAggregation?: string;
  spaceAggregation?: string;
  groupBy: { name: string; context: string }[];
  filterExpr?: string;
  limit?: number;
  legend?: string; // mapped from Grafana legendFormat
  variables?: string[]; // SigNoz dashboard variable field-names this query references
}
export interface TargetResult {
  refId: string;
  expr: string;
  ok: boolean;
  status: 'validated' | 'validated_with_renames' | 'needs_review' | 'unsupported';
  metricName?: string;
  seriesCount?: number;
  renames: string[];
  notes: string[];
  error?: string;
  resolved?: ResolvedQuery; // set when validated — used to assemble the widget
}
export interface PanelMigration {
  panelId: string;
  title: string;
  status: TargetResult['status'];
  targets: TargetResult[];
}

/** metric rename map from the readiness report (prom name → otel name) */
function renameMap(report: ReadinessReport): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of report.metrics) if (it.verdict === 'renamed' && it.mappedTo) m.set(it.name, it.mappedTo);
  return m;
}

type Ctx = 'resource' | 'attribute' | 'span' | 'scope';
const fieldCache = new Map<string, Map<string, Ctx>>();

/** otelName → preferred fieldContext for a metric's label keys */
async function fieldContexts(mcp: SigNozMcp, metric: string): Promise<Map<string, Ctx>> {
  if (fieldCache.has(metric)) return fieldCache.get(metric)!;
  const out = new Map<string, Ctx>();
  try {
    const res = await mcp.call<{ data?: { keys?: Record<string, { fieldContext?: string }[]> } }>(
      'get_field_keys',
      { signal: 'metrics', metricName: metric },
    );
    for (const [name, variants] of Object.entries(res?.data?.keys ?? {})) {
      const ctxs = variants.map((v) => v.fieldContext).filter(Boolean) as Ctx[];
      // prefer resource (fixes the service.name ambiguity — F4), else first available
      const pick = ctxs.includes('resource') ? 'resource' : (ctxs[0] ?? 'attribute');
      out.set(name, pick);
    }
  } catch {
    /* leave empty; caller defaults to attribute */
  }
  fieldCache.set(metric, out);
  return out;
}

const promToOtelLabel = (l: string): string => l.replace(/_/g, '.');

function transformFilter(expr: string | undefined, labels: string[]): string | undefined {
  if (!expr) return expr;
  let out = expr;
  for (const l of labels) out = out.replace(new RegExp(`\\b${l}\\b`, 'g'), promToOtelLabel(l));
  return out;
}

/** Convert Grafana template-var matchers into SigNoz dashboard-variable references.
 * `service.name REGEXP '$service'` → `service.name IN $service.name` (var named after the field),
 * preserving the dashboard's service/etc. scoping instead of dropping it. */
const GRAFANA_VAR = /\$\{?[\w:.]+\}?|\[\[[\w.]+\]\]/; // $v, ${v}, ${v:regex}, [[v]]
function convertTemplateVars(expr: string | undefined): { expr?: string; variables: string[] } {
  if (!expr) return { variables: [] };
  const variables = new Set<string>();
  const clauses = expr.split(/\s+AND\s+/i).map((c) => {
    const m = c.match(/^\s*([\w.]+)\s*(REGEXP|=~|=|!=|IN)\s*(.+?)\s*$/i);
    if (m && GRAFANA_VAR.test(m[3]!)) {
      const field = m[1]!;
      variables.add(field); // SigNoz variable named after the field (per docs)
      return `${field} IN $${field}`; // multi-select reference
    }
    return c;
  });
  return { expr: clauses.join(' AND '), variables: [...variables] };
}

/** map a Grafana legendFormat ("{{span_name}}") to SigNoz ("{{span.name}}") */
function mapLegend(legend: string | undefined): string | undefined {
  if (!legend) return undefined;
  return legend.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_, k) => `{{${String(k).replace(/_/g, '.')}}}`);
}

async function validateQuery(
  mcp: SigNozMcp,
  spec: Record<string, unknown>,
): Promise<{ ok: boolean; seriesCount?: number; error?: string }> {
  const now = Date.now();
  const query = {
    schemaVersion: 'v1',
    start: now - 3_600_000,
    end: now,
    requestType: 'time_series',
    compositeQuery: { queries: [{ type: 'builder_query', spec }] },
    formatOptions: { formatTableResultForUI: false, fillGaps: false },
    variables: {},
  };
  try {
    const res = await mcp.call<{ data?: { data?: { results?: { aggregations?: unknown[] | null }[] } } }>(
      'execute_builder_query',
      { query },
    );
    const aggs = res?.data?.data?.results?.[0]?.aggregations;
    if (Array.isArray(aggs) && aggs.length > 0) {
      const series = (aggs[0] as { series?: unknown[] })?.series?.length ?? 0;
      return { ok: series > 0, seriesCount: series };
    }
    return { ok: false, error: '200 but null/empty aggregations' }; // F4/F2
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 160) }; // e.g. histogram 500 (F5)
  }
}

async function migrateTarget(
  mcp: SigNozMcp,
  target: GrafanaTarget,
  renames: Map<string, string>,
  labels: string[],
): Promise<TargetResult> {
  const { refId, expr } = target;
  const notes: string[] = [];
  const usedRenames: string[] = [];
  const mapped = mapPromql(expr, refId);
  if (!mapped.ok || !mapped.query) {
    return { refId, expr, ok: false, status: 'unsupported', renames: [], notes: mapped.unsupported ?? ['unsupported'] };
  }
  const q = mapped.query;
  notes.push(...mapped.notes);

  // metric rename
  if (q.metricName && renames.has(q.metricName)) {
    const to = renames.get(q.metricName)!;
    usedRenames.push(`${q.metricName} → ${to}`);
    q.metricName = to;
  }
  const ctxMap = q.metricName ? await fieldContexts(mcp, q.metricName) : new Map<string, Ctx>();

  // build v5 spec (metrics signal)
  const groupBy = q.groupBy.map((g) => {
    const name = promToOtelLabel(g);
    if (g !== name) usedRenames.push(`${g} → ${name}`);
    return { name, fieldContext: ctxMap.get(name) ?? 'attribute' };
  });
  const spec: Record<string, unknown> = {
    name: refId,
    signal: 'metrics',
    stepInterval: 60,
    // NOTE (F16): sending temporality:'Unspecified' makes the query return null
    // aggregations despite scanning rows. Omit temporality; the backend infers it.
    aggregations: [
      { metricName: q.metricName, timeAggregation: q.timeAggregation, spaceAggregation: q.spaceAggregation },
    ],
    groupBy,
    disabled: false,
  };
  const renamed = transformFilter(q.filterExpr, labels);
  const { expr: filterExpr, variables } = convertTemplateVars(renamed);
  if (variables.length) notes.push(`template vars → SigNoz variables: ${variables.join(', ')}`);
  // for validation only, strip variable clauses (variables aren't bound at validate time)
  const validateFilter = filterExpr?.split(/\s+AND\s+/i).filter((c) => !c.includes('$')).join(' AND ') || undefined;
  if (validateFilter) spec.filter = { expression: validateFilter };
  if (q.limit) spec.limit = q.limit;

  const v = await validateQuery(mcp, spec);
  let status: TargetResult['status'];
  if (v.ok) status = usedRenames.length ? 'validated_with_renames' : 'validated';
  else status = 'needs_review';
  if (v.error) notes.push(`validation: ${v.error}`);

  const resolved: ResolvedQuery | undefined = v.ok
    ? {
        metricName: q.metricName!,
        timeAggregation: q.timeAggregation,
        spaceAggregation: q.spaceAggregation,
        groupBy: groupBy.map((g) => ({ name: g.name, context: g.fieldContext })),
        filterExpr, // keeps the $variable references for the created dashboard
        limit: q.limit,
        // legend must reference the actual group-by keys to render; else fall back to Grafana's format
        legend: groupBy.length ? groupBy.map((g) => `{{${g.name}}}`).join(' - ') : mapLegend(target.legend),
        variables,
      }
    : undefined;

  return { refId, expr, ok: v.ok, status, metricName: q.metricName, seriesCount: v.seriesCount, renames: usedRenames, notes, error: v.error, resolved };
}

export async function migrateDashboard(
  dash: ParsedDashboard,
  report: ReadinessReport,
  mcp: SigNozMcp,
): Promise<PanelMigration[]> {
  const renames = renameMap(report);
  const labels = dash.dependencies.labels;
  const out: PanelMigration[] = [];
  for (const panel of dash.panels) {
    const targets: TargetResult[] = [];
    for (const t of panel.targets) targets.push(await migrateTarget(mcp, t, renames, labels));
    // panel status = worst of its targets
    const order = ['validated', 'validated_with_renames', 'needs_review', 'unsupported'] as const;
    const worst = targets.reduce((w, t) => Math.max(w, order.indexOf(t.status)), 0);
    out.push({ panelId: panel.id, title: panel.title, status: order[worst] ?? 'validated', targets });
  }
  return out;
}

// ---- Assemble + apply (create the migrated dashboard) -------------------

const PANEL_TYPE: Record<string, string> = {
  bargauge: 'bar', gauge: 'graph', timeseries: 'graph', graph: 'graph',
  stat: 'value', table: 'table', piechart: 'pie',
};
const ctxToWidgetType = (c: string): string => (c === 'resource' ? 'resource' : 'tag');

/** build a SigNoz dashboard widget from a validated target's resolved query */
function assembleWidget(panelId: string, title: string, gtype: string, r: ResolvedQuery): Record<string, unknown> {
  const data: Record<string, unknown> = {
    queryName: 'A', expression: 'A', dataSource: 'metrics', stepInterval: 60,
    aggregations: [{ metricName: r.metricName, timeAggregation: r.timeAggregation, spaceAggregation: r.spaceAggregation }],
    groupBy: r.groupBy.map((g) => ({ key: g.name, dataType: 'string', type: ctxToWidgetType(g.context) })),
    legend: r.groupBy.length ? `{{${r.groupBy[0]!.name}}}` : '',
    orderBy: [], selectColumns: [], functions: [], disabled: false,
  };
  if (r.filterExpr) data.filter = { expression: r.filterExpr };
  if (r.limit) data.limit = r.limit;
  return {
    id: `otto-${panelId}`, title, description: '', panelTypes: PANEL_TYPE[gtype] ?? 'graph',
    nullZeroValues: 'zero', opacity: '1', timePreferance: 'GLOBAL_TIME', yAxisUnit: 'none',
    selectedLogFields: [], selectedTracesFields: [], thresholds: [], contextLinks: { linksData: [] },
    query: { id: `q-${panelId}`, queryType: 'builder', promql: [], clickhouse_sql: [], builder: { queryData: [data], queryFormulas: [] } },
  };
}

export interface AssembledDashboard {
  title: string; description: string; tags: string[];
  layout: Record<string, unknown>[]; widgets: Record<string, unknown>[];
  included: number; skipped: { title: string; status: string }[];
}

export function assembleDashboard(
  dash: { title: string; panels: { id: string; title: string; grafanaType: string }[] },
  migrations: PanelMigration[],
  title?: string,
): AssembledDashboard {
  const byId = new Map(dash.panels.map((p) => [p.id, p]));
  const widgets: Record<string, unknown>[] = [];
  const layout: Record<string, unknown>[] = [];
  const skipped: { title: string; status: string }[] = [];
  let y = 0;

  for (const m of migrations) {
    const t = m.targets.find((x) => x.resolved);
    const panel = byId.get(m.panelId);
    if (!t?.resolved || !panel) {
      skipped.push({ title: m.title, status: m.status });
      continue;
    }
    widgets.push(assembleWidget(m.panelId, m.title, panel.grafanaType, t.resolved));
    layout.push({ i: `otto-${m.panelId}`, x: (widgets.length % 2) * 6, y, w: 6, h: 6 });
    if (widgets.length % 2 === 0) y += 6;
  }

  const desc = [
    `Auto-migrated from Grafana "${dash.title}" by Otto.`,
    `${widgets.length} panels migrated.`,
    skipped.length ? `Skipped (needs agent/review): ${skipped.map((s) => `${s.title} [${s.status}]`).join('; ')}` : '',
  ].filter(Boolean).join(' ');

  return {
    title: title ?? `${dash.title} — Otto migration`,
    description: desc, tags: ['otto', 'migrated', 'grafana'],
    layout, widgets, included: widgets.length, skipped,
  };
}

export async function applyDashboard(
  mcp: SigNozMcp,
  a: AssembledDashboard & { variables?: Record<string, unknown>; panelMap?: Record<string, unknown> },
): Promise<{ id?: string; raw: unknown }> {
  const raw = await mcp.call('create_dashboard', {
    title: a.title, description: a.description, tags: a.tags, layout: a.layout, widgets: a.widgets,
    ...(a.variables && Object.keys(a.variables).length ? { variables: a.variables } : {}),
    ...(a.panelMap && Object.keys(a.panelMap).length ? { panelMap: a.panelMap } : {}),
  });
  const id = (raw as { data?: { id?: string } })?.data?.id ?? (raw as { id?: string })?.id;
  return { id, raw };
}

/** build SigNoz QUERY dashboard variables from Grafana template-var field names.
 * QUERY type is what real SigNoz templates use and it reliably populates the dropdown
 * (the DYNAMIC shape needs UI-only config we can't fully set from the API). Schema
 * mirrors the postgres out-of-box template. */
export function buildSigNozVariables(fields: string[]): Record<string, Record<string, unknown>> {
  const vars: Record<string, Record<string, unknown>> = {};
  [...new Set(fields)].forEach((f, i) => {
    const id = (globalThis.crypto?.randomUUID?.() ?? `var_${f}_${i}`);
    const queryValue = `SELECT DISTINCT JSONExtractString(labels, '${f}') AS \`${f}\`\nFROM signoz_metrics.distributed_time_series_v4_1day\nWHERE JSONExtractString(labels, '${f}') != ''\nGROUP BY \`${f}\``;
    vars[id] = {
      id, key: id, name: f, type: 'QUERY',
      queryValue, customValue: '', textboxValue: '', selectedValue: [],
      multiSelect: true, showALLOption: true, allSelected: true,
      sort: 'ASC', order: i, description: `service selector (migrated from Grafana template variable)`,
      modificationUUID: (globalThis.crypto?.randomUUID?.() ?? `mod_${f}_${i}`),
    };
  });
  return vars;
}
