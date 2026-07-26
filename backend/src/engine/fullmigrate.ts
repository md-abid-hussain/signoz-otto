// Full migration: deterministic core + agent tail, migrating EVERY panel.
// Per panel: try deterministic (mapper→validate); if not validated, hand to the
// agent (histogram→traces, ratios→formula, exotic→closest). Assemble widgets from
// whichever validated, create the complete dashboard. Static/failed panels are
// listed in the description — nothing silently dropped.

import type { ParsedDashboard } from '../ingest/grafana.js';
import type { PanelSpec, ReadinessReport, Receipt } from '../types.js';
import type { SigNozMcp } from '../signoz/mcp.js';
import { migrateDashboard, applyDashboard, buildSigNozVariables, type PanelMigration } from './migrate.js';
import { agentTranslatePanel, type AgentQuery, type AgentResult } from '../agent/translate.js';
import { agentMatchMetrics } from '../agent/match.js';
import { fetchInstanceMetrics } from '../readiness/index.js';
import { withSpan, recordPanel, recordLlm, recordRunDuration, annotateSpan } from '../otel/index.js';

const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-5.6-terra';

/** LLM semantic-match pass: upgrade 'missing' metrics that are really structural renames.
 * Mutates the report (missing → renamed) so the deterministic mapper can then migrate them. */
async function semanticRecover(report: ReadinessReport, mcp: SigNozMcp): Promise<{ recovered: string[]; usage: { calls: number; inputTokens: number; outputTokens: number } }> {
  const missing = report.metrics.filter((m) => m.verdict === 'missing').map((m) => m.name);
  if (!missing.length) return { recovered: [], usage: { calls: 0, inputTokens: 0, outputTokens: 0 } };
  const instance = await fetchInstanceMetrics(mcp);
  const { matches, usage } = await agentMatchMetrics(missing, instance);
  const recovered: string[] = [];
  for (const item of report.metrics) {
    const to = matches[item.name];
    if (item.verdict === 'missing' && to) {
      item.verdict = 'renamed';
      item.mappedTo = to;
      item.reason = `LLM semantic match (${item.name} → ${to})`;
      recovered.push(`${item.name} → ${to}`);
    }
  }
  report.summary = {
    matched: report.metrics.filter((m) => m.verdict === 'matched').length,
    renamed: report.metrics.filter((m) => m.verdict === 'renamed').length,
    missing: report.metrics.filter((m) => m.verdict === 'missing').length,
  };
  return { recovered, usage };
}

export interface PanelOutcome {
  panelId: string; title: string; grafanaType: string;
  path: 'deterministic' | 'agent' | 'none';
  status: string; notes: string; seriesCount?: number;
}

// Grafana panel type → SigNoz panel type (verified against signoz://dashboard/widgets-instructions:
// SigNoz has 7 types — bar, histogram, list, pie, table, graph(timeseries), value — and NO arc-dial gauge).
// gauge (single-value dial) and stat both collapse to a single number → SigNoz "value".
const PANEL_TYPE: Record<string, string> = {
  bargauge: 'bar', gauge: 'value', timeseries: 'graph', graph: 'graph',
  stat: 'value', table: 'table', piechart: 'pie', histogram: 'histogram',
  logs: 'list', nodeGraph: 'graph',
};
const ctxToType = (c: string): string => (c === 'resource' ? 'resource' : 'tag');

// Grafana unit code → SigNoz yAxisUnit (so latency renders as "5s" not "5000000000")
const UNIT_MAP: Record<string, string> = {
  s: 's', ms: 'ms', ns: 'ns', us: 'us', µs: 'us', reqps: 'reqps', ops: 'ops', rps: 'reqps',
  percent: 'percent', percentunit: 'percentunit', bytes: 'bytes', decbytes: 'bytes',
  short: 'none', none: 'none', '': 'none',
};
/** trace duration is nanoseconds → force 'ns' (SigNoz auto-formats); else map the Grafana unit */
function yUnit(grafanaUnit: string | undefined, usesDurationNano: boolean): string {
  if (usesDurationNano) return 'ns';
  const u = grafanaUnit ?? '';
  return UNIT_MAP[u] ?? u ?? 'none';
}
const hasDurationNano = (aggs: { expression?: string }[]): boolean =>
  aggs.some((a) => (a.expression ?? '').includes('duration_nano'));

/** A Value panel renders ONE number — a grouped/multi-series query makes it show NaN. "Top-N by
 * category" (e.g. a Grafana gauge with topk(...) by span_name) is a Bar panel in SigNoz. (Verified:
 * the migrated gauge+topk latency panel rendered "NaN" as a value panel.) */
function panelTypeFor(base: string, hasGroupBy: boolean): string {
  return base === 'value' && hasGroupBy ? 'bar' : base;
}

function widgetFromDeterministic(panel: PanelSpec, r: NonNullable<PanelMigration['targets'][number]['resolved']>): Record<string, unknown> {
  const pt = panelTypeFor(PANEL_TYPE[panel.grafanaType] ?? 'graph', r.groupBy.length > 0);
  const data: Record<string, unknown> = {
    queryName: 'A', expression: 'A', dataSource: 'metrics', stepInterval: 60,
    aggregations: [{ metricName: r.metricName, timeAggregation: r.timeAggregation, spaceAggregation: r.spaceAggregation }],
    groupBy: r.groupBy.map((g) => ({ key: g.name, dataType: 'string', type: ctxToType(g.context) })),
    legend: r.legend ?? (r.groupBy.length ? `{{${r.groupBy[0]!.name}}}` : ''),
    orderBy: [], selectColumns: [], functions: [], disabled: false,
    ...(pt === 'value' ? { reduceTo: 'avg' } : {}), // a value panel needs a reduction or it renders NaN
    ...(r.filterExpr ? { filter: { expression: r.filterExpr } } : {}),
    ...(r.limit ? { limit: r.limit } : {}),
  };
  return wrapWidget(panel.id, panel.title, pt, [data], [], yUnit(panel.unit, false));
}

function widgetFromAgent(panel: PanelSpec, a: AgentResult): Record<string, unknown> {
  const usesDur = a.queries.some((q) => hasDurationNano(q.aggregations));
  const hasGroupBy = a.queries.some((q) => (q.groupBy?.length ?? 0) > 0);
  const pt = panelTypeFor(a.panelType ?? PANEL_TYPE[panel.grafanaType] ?? 'graph', hasGroupBy);
  const queryData = a.queries.map((q: AgentQuery) => ({
    queryName: q.name, expression: q.name, dataSource: q.signal, stepInterval: 60,
    aggregations: q.aggregations,
    groupBy: (q.groupBy ?? []).map((g) => ({ key: g.name, dataType: 'string', type: ctxToType(g.fieldContext) })),
    legend: (q.groupBy?.length ? q.groupBy.map((g) => `{{${g.name}}}`).join(' - ') : q.legend) ?? '',
    orderBy: [], selectColumns: [], functions: [], disabled: q.disabled ?? false,
    ...(pt === 'value' ? { reduceTo: 'avg' } : {}),
    ...(q.filter ? { filter: q.filter } : {}),
    ...(q.limit ? { limit: q.limit } : {}),
  }));
  const formulas = a.formula
    ? [{ queryName: a.formula.name, expression: a.formula.expression, disabled: false, dataSource: 'metrics', stepInterval: 60, aggregations: [], groupBy: [], orderBy: [], selectColumns: [], functions: [], limit: 0 }]
    : [];
  return wrapWidget(panel.id, panel.title, pt, queryData, formulas, yUnit(panel.unit, usesDur));
}

function wrapWidget(panelId: string, title: string, panelTypes: string, queryData: unknown[], queryFormulas: unknown[], yAxisUnit = 'none'): Record<string, unknown> {
  return {
    id: `otto-${panelId}`, title, description: '', panelTypes,
    nullZeroValues: 'zero', opacity: '1', timePreferance: 'GLOBAL_TIME', yAxisUnit,
    selectedLogFields: [], selectedTracesFields: [], thresholds: [], contextLinks: { linksData: [] },
    query: { id: `q-${panelId}`, queryType: 'builder', promql: [], clickhouse_sql: [], builder: { queryData, queryFormulas } },
  };
}

function layoutFor(p: PanelSpec): Record<string, unknown> {
  return { i: `otto-${p.id}`, x: Math.floor(p.gridPos.x / 2), y: p.gridPos.y, w: Math.max(1, Math.floor(p.gridPos.w / 2)), h: p.gridPos.h, moved: false, static: false };
}

/** which Grafana section a panel at grid-row `y` belongs to (last row header at or above it) */
function sectionIdxForY(y: number, sections: { y: number }[]): number {
  const ordered = [...sections].sort((a, b) => a.y - b.y);
  let best = -1;
  ordered.forEach((s, i) => { if (s.y <= y) best = i; });
  return best;
}

/** best-effort deep-find of the first array/string under a key (get_dashboard nests under data.data) */
function findArr(obj: unknown, key: string): unknown[] | undefined {
  return findBy(obj, key, Array.isArray) as unknown[] | undefined;
}
function findStr(obj: unknown, key: string): string | undefined {
  return findBy(obj, key, (v) => typeof v === 'string') as string | undefined;
}
function findBy(obj: unknown, key: string, pred: (v: unknown) => boolean): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  if (key in rec && pred(rec[key])) return rec[key];
  for (const v of Object.values(rec)) {
    const hit = findBy(v, key, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// ---- dashboard variable resolution (do it properly: no broken $var reaches SigNoz) -------

/** drop AND-clauses that reference any $variable in `dropped` (optional/unresolvable vars).
 * handles the Grafana optional-filter idiom `(trace_id = $traceId OR $traceId = "")` as one clause. */
function dropVarClauses(expr: string | undefined, dropped: Set<string>): string | undefined {
  if (!expr) return expr;
  const refsDropped = (clause: string) =>
    [...dropped].some((v) => new RegExp(`\\$\\{?${v.replace(/\./g, '\\.')}\\}?`).test(clause));
  const kept = expr.split(/\s+AND\s+/i).filter((c) => !refsDropped(c));
  return kept.length ? kept.join(' AND ') : undefined;
}

/** strip dropped-variable references from every built widget's filter expressions */
function sanitizeWidgetFilters(built: { widget: Record<string, unknown> }[], dropped: Set<string>): void {
  if (!dropped.size) return;
  for (const b of built) {
    const builder = (b.widget.query as { builder?: { queryData?: Record<string, unknown>[] } })?.builder;
    for (const q of builder?.queryData ?? []) {
      const f = q.filter as { expression?: string } | undefined;
      if (!f?.expression) continue;
      const cleaned = dropVarClauses(f.expression, dropped);
      if (cleaned) f.expression = cleaned; else delete q.filter;
    }
  }
}

/** decide which collected variables are real: query-backed (Grafana type=query) AND resolving to
 * live values. Grafana textbox/constant/custom vars — and the optional-empty filter idiom they
 * drive — have no faithful SigNoz equivalent, so they and their filter clauses are dropped rather
 * than shipped as a QUERY variable that returns nothing and 400s every query referencing it. */
async function resolveVariables(
  mcp: SigNozMcp, fields: string[], freeText: Set<string>,
): Promise<{ keep: string[]; dropped: Set<string> }> {
  const keep: string[] = [];
  const dropped = new Set<string>();
  for (const f of fields) {
    const bare = f.replace(/^\$/, '');
    if (freeText.has(bare) || freeText.has(bare.split('.')[0]!)) { dropped.add(f); continue; }
    let resolved = false, checked = false;
    for (const signal of ['metrics', 'traces', 'logs'] as const) {
      try {
        const res = await mcp.call<unknown>('get_field_values', { signal, name: f });
        checked = true;
        const sv = findArr(res, 'stringValues'); const nv = findArr(res, 'numberValues');
        if ((sv?.length ?? 0) > 0 || (nv?.length ?? 0) > 0) { resolved = true; break; }
      } catch { /* signal not applicable — try the next */ }
    }
    // keep if it resolves live; also keep if we couldn't check at all (never drop a good var on tool failure)
    if (resolved || !checked) keep.push(f); else dropped.add(f);
  }
  return { keep, dropped };
}

/** group migrated panels under SigNoz section rows mirroring Grafana's row headers (skill: rows + panelMap) */
function assembleWithSections(
  built: { widget: Record<string, unknown>; panel: PanelSpec }[],
  sections: { title: string; y: number }[],
): { widgets: Record<string, unknown>[]; layout: Record<string, unknown>[]; panelMap: Record<string, unknown> } {
  const widgets: Record<string, unknown>[] = [];
  const layout: Record<string, unknown>[] = [];
  const panelMap: Record<string, unknown> = {};
  const ordered = [...sections].sort((a, b) => a.y - b.y);
  const sectionIdxFor = (y: number): number => { let best = -1; ordered.forEach((s, i) => { if (s.y <= y) best = i; }); return best; };

  const noSection: typeof built = [];
  const bySection = new Map<number, typeof built>();
  for (const b of built) {
    const idx = sectionIdxFor(b.panel.gridPos.y);
    if (idx < 0) noSection.push(b);
    else (bySection.get(idx) ?? bySection.set(idx, []).get(idx)!).push(b);
  }

  for (const b of noSection) { widgets.push(b.widget); layout.push(layoutFor(b.panel)); }
  ordered.forEach((s, i) => {
    const items = bySection.get(i);
    if (!items?.length) return; // skip empty sections (nothing migrated under them)
    const rowId = globalThis.crypto?.randomUUID?.() ?? `row-${i}`;
    // row widgets still need the full required-field set per the create_dashboard schema
    widgets.push({
      id: rowId, panelTypes: 'row', title: s.title, description: '',
      query: { queryType: 'builder', promql: [], clickhouse_sql: [], builder: { queryData: [], queryFormulas: [] } },
      selectedLogFields: [], selectedTracesFields: [], thresholds: [], contextLinks: { linksData: [] },
    });
    layout.push({ i: rowId, x: 0, y: s.y, w: 12, h: 1, moved: false, static: false });
    const childLayouts = items.map((b) => layoutFor(b.panel));
    for (const b of items) widgets.push(b.widget);
    for (const l of childLayouts) layout.push(l);
    panelMap[rowId] = { collapsed: false, widgets: childLayouts };
  });
  return { widgets, layout, panelMap };
}

export interface FullMigrationResult {
  outcomes: PanelOutcome[];
  createdId?: string;
  included: number;
  dashboard: { title: string; description: string; tags: string[]; layout: Record<string, unknown>[]; widgets: Record<string, unknown>[] };
  receipt: Receipt;
}

export type MigrateEvent =
  | { type: 'stage'; stage: string; status: 'start' | 'done'; note?: string }
  | { type: 'panel'; panelId: string; title: string; path: string; status: string; note?: string };
export type MigrateOpts = { apply?: boolean; title?: string; onEvent?: (e: MigrateEvent) => void };

/** Root-span wrapper: every migration is a trace (otto.run → panel.migrate → llm.call). */
export async function fullMigrate(
  dash: ParsedDashboard,
  report: ReadinessReport,
  mcp: SigNozMcp,
  opts: MigrateOpts = {},
): Promise<FullMigrationResult> {
  return withSpan('otto.run', { 'otto.playbook': 'migration', 'otto.dashboard': dash.title, 'otto.panels_total': dash.panels.length }, async () => {
    const res = await fullMigrateInner(dash, report, mcp, opts);
    annotateSpan({ 'otto.migrated': res.included, 'otto.recovered': res.receipt.recovered.length, 'otto.created_id': res.createdId ?? '' });
    recordRunDuration(res.receipt.durationMs, 'migration', res.createdId ? 'applied' : 'dry_run');
    for (const o of res.outcomes) recordPanel(o.status, o.path);
    return res;
  });
}

async function fullMigrateInner(
  dash: ParsedDashboard,
  report: ReadinessReport,
  mcp: SigNozMcp,
  opts: MigrateOpts = {},
): Promise<FullMigrationResult> {
  const t0 = Date.now();
  const emit = opts.onEvent ?? (() => {});
  const llm = { calls: 0, inputTokens: 0, outputTokens: 0 };
  // LLM semantic-recovery: turn structural-rename "missing" metrics into renames first
  const rec = await withSpan('semantic.recover', { 'otto.model': LLM_MODEL }, () => semanticRecover(report, mcp));
  const recovered = rec.recovered;
  llm.calls += rec.usage.calls; llm.inputTokens += rec.usage.inputTokens; llm.outputTokens += rec.usage.outputTokens;
  if (rec.usage.calls) recordLlm(rec.usage.inputTokens, rec.usage.outputTokens, LLM_MODEL);
  emit({ type: 'stage', stage: 'recover', status: 'done', note: recovered.length ? `${recovered.length} metric(s) recovered` : 'no renames needed' });
  emit({ type: 'stage', stage: 'translate', status: 'start', note: `${dash.panels.length} panels` });
  const det = await migrateDashboard(dash, report, mcp);
  const renames = new Map(report.metrics.filter((m) => m.mappedTo).map((m) => [m.name, m.mappedTo!]));
  const avail = report.metrics.map((m) => m.mappedTo ?? m.name);
  const panelById = new Map(dash.panels.map((p) => [p.id, p]));

  // panels whose every referenced metric is missing → instrumentation gap, not an agent task
  const missingByPanel = new Map<string, boolean>();
  for (const p of dash.panels) {
    const refs = report.metrics.filter((m) => m.panelsAffected.includes(p.id));
    missingByPanel.set(p.id, refs.length > 0 && refs.every((m) => m.verdict === 'missing'));
  }

  const built: { widget: Record<string, unknown>; panel: PanelSpec }[] = [];
  const outcomes: PanelOutcome[] = [];
  const pushOutcome = (o: PanelOutcome) => { outcomes.push(o); emit({ type: 'panel', panelId: o.panelId, title: o.title, path: o.path, status: o.status, note: o.notes }); };
  const usedVariables = new Set<string>();
  const panelCap = Number(process.env.RUN_PANEL_CAP ?? 50);
  let agentPanels = 0;

  for (const pm of det) {
    const panel = panelById.get(pm.panelId)!;
    const detTarget = pm.targets.find((t) => t.resolved);
    if (detTarget?.resolved) {
      built.push({ widget: widgetFromDeterministic(panel, detTarget.resolved), panel });
      for (const v of detTarget.resolved.variables ?? []) usedVariables.add(v);
      pushOutcome({ panelId: pm.panelId, title: pm.title, grafanaType: panel.grafanaType, path: 'deterministic', status: pm.status, notes: detTarget.renames.join(', '), seriesCount: detTarget.seriesCount });
      continue;
    }
    // instrumentation gap: metrics genuinely absent from SigNoz — auditor's job, not the agent's
    if (missingByPanel.get(pm.panelId)) {
      pushOutcome({ panelId: pm.panelId, title: pm.title, grafanaType: panel.grafanaType, path: 'none', status: 'missing', notes: 'metrics not in SigNoz — instrument the source, then re-migrate' });
      continue;
    }
    // limit (N4): cap how many panels the LLM handles per run — no token budgeting, just bounded work
    if (agentPanels >= panelCap) {
      pushOutcome({ panelId: pm.panelId, title: pm.title, grafanaType: panel.grafanaType, path: 'none', status: 'needs_review', notes: `run panel cap (${panelCap}) reached — re-run to migrate the rest` });
      continue;
    }
    // agent tail — one trace: panel.migrate → llm.call
    agentPanels++;
    const a = await withSpan('panel.migrate', { 'otto.panel': panel.title, 'otto.grafana_type': panel.grafanaType, 'otto.path': 'agent' }, async (pspan) => {
      const r = await withSpan('llm.call', { 'otto.model': LLM_MODEL, 'otto.panel': panel.title }, async (lspan) => {
        const rr = await agentTranslatePanel(mcp, panel, renames, avail);
        if (rr.usage) lspan.setAttributes({ 'otto.in_tokens': rr.usage.inputTokens, 'otto.out_tokens': rr.usage.outputTokens, 'otto.llm_calls': rr.usage.calls });
        return rr;
      });
      pspan.setAttributes({ 'otto.status': r.status });
      return r;
    });
    if (a.usage) { llm.calls += a.usage.calls; llm.inputTokens += a.usage.inputTokens; llm.outputTokens += a.usage.outputTokens; recordLlm(a.usage.inputTokens, a.usage.outputTokens, LLM_MODEL); }
    if (a.status === 'validated') {
      built.push({ widget: widgetFromAgent(panel, a), panel });
      for (const v of a.variables ?? []) usedVariables.add(v);
      pushOutcome({ panelId: pm.panelId, title: pm.title, grafanaType: panel.grafanaType, path: 'agent', status: 'validated', notes: a.notes, seriesCount: a.seriesCount });
    } else {
      pushOutcome({ panelId: pm.panelId, title: pm.title, grafanaType: panel.grafanaType, path: 'none', status: a.status, notes: a.notes });
    }
  }

  // resolve variables properly: only data-backed vars that live-resolve become SigNoz variables;
  // free-text/optional ones (e.g. a Grafana `traceId` textbox) and their filter clauses are dropped
  // so no unresolvable $var reaches the dashboard and 400s every query that references it.
  emit({ type: 'stage', stage: 'assemble', status: 'start', note: `${built.length} panels` });
  const freeText = new Set(dash.variables.filter((v) => v.type !== 'query').map((v) => v.name));
  const { keep, dropped } = await resolveVariables(mcp, [...usedVariables], freeText);
  sanitizeWidgetFilters(built, dropped);

  // group into section rows mirroring the Grafana layout
  const { widgets, layout, panelMap } = assembleWithSections(built, dash.sections);
  emit({ type: 'stage', stage: 'assemble', status: 'done', note: keep.length ? `variables: ${keep.join(', ')}` : undefined });

  // FAITHFUL replica metadata (skill: proper title/description/tags) — original values,
  // NOT an Otto migration report. The migration details live in the Receipt.
  const variables = buildSigNozVariables(keep);
  const dashboard = {
    title: opts.title ?? dash.title, // original title, verbatim
    description: dash.description ?? `${dash.title} (migrated to SigNoz).`,
    tags: [...new Set([...dash.tags, 'migrated'])], // original tags + one marker
    layout, widgets,
  };
  let createdId: string | undefined;
  if (opts.apply && built.length) {
    emit({ type: 'stage', stage: 'apply', status: 'start', note: 'creating dashboard in SigNoz' });
    // panelMap passed only if the create tool accepts it; rows in widgets/layout render sections regardless
    const { id } = await applyDashboard(mcp, { ...dashboard, included: built.length, skipped: [], variables, panelMap: {} });
    createdId = id;
    emit({ type: 'stage', stage: 'apply', status: 'done', note: id ? `created ${id}` : 'created' });
  }
  const counts: Record<string, number> = {};
  for (const o of outcomes) counts[o.status] = (counts[o.status] ?? 0) + 1;

  // verification = replication check: read the created dashboard back and compare to the original
  let fidelity: Receipt['fidelity'];
  if (createdId) {
    try {
      const got = await mcp.call<unknown>('get_dashboard', { id: createdId });
      const gw = findArr(got, 'widgets') ?? [];
      const gTags = (findArr(got, 'tags') ?? []) as string[];
      const gDesc = findStr(got, 'description');
      const gTitle = findStr(got, 'title');
      const rowsMade = gw.filter((w) => (w as { panelTypes?: string }).panelTypes === 'row').length;
      const usedSections = new Set(built.map((b) => sectionIdxForY(b.panel.gridPos.y, dash.sections)).filter((i) => i >= 0));
      const sectionsExpected = usedSections.size;
      fidelity = {
        titleMatch: gTitle === dash.title,
        tagsCarried: dash.tags.every((t) => gTags.includes(t)),
        descriptionPresent: !!gDesc && gDesc.length > 5,
        sectionsExpected, sectionsCreated: rowsMade,
        panelsMigrated: built.length, panelsTotal: dash.panels.length,
      };
    } catch { /* verification is best-effort */ }
    emit({ type: 'stage', stage: 'verify', status: 'done', note: fidelity ? `replication ${fidelity.panelsMigrated}/${fidelity.panelsTotal}` : undefined });
  }

  const receipt: Receipt = {
    playbook: 'migration', total: dash.panels.length, migrated: built.length,
    counts, recovered, llm, durationMs: Date.now() - t0,
    artifacts: createdId ? [createdId] : [], fidelity,
    variables: { kept: keep, dropped: [...dropped] },
  };
  return { outcomes, createdId, included: built.length, dashboard: { ...dashboard, variables } as never, receipt };
}
