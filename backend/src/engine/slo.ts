// SLO copilot playbook — codifies the manual run 3 flow.
// analyze (aggregate_traces evidence) → propose (evidence-based target, reasoning shown)
// → apply (SLI/error-budget dashboard + fast-burn alert). Read-only until apply.

import { ChatOpenAI } from '@langchain/openai';
import type { SigNozMcp } from '../signoz/mcp.js';
import type { SloEvidence, SloProposal, SloAnalysis } from '../types.js';

/** pull the single scalar out of an aggregate_traces result (envelope-agnostic) */
function scalar(res: unknown): number {
  const find = (o: unknown): number | undefined => {
    if (Array.isArray(o)) {
      for (const x of o) { const r = find(x); if (r !== undefined) return r; }
      return undefined;
    }
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      if (Array.isArray(rec.data)) { const r = find(rec.data); if (r !== undefined) return r; }
      for (const v of Object.values(rec)) { const r = find(v); if (r !== undefined) return r; }
      return undefined;
    }
    return typeof o === 'number' ? o : undefined;
  };
  // results[].data is [[...,value]]; grab the last numeric found
  const r = res as { data?: { data?: { results?: { data?: unknown[][] }[] } } };
  const rows = r?.data?.data?.results?.[0]?.data;
  if (Array.isArray(rows) && rows.length) {
    const last = rows[0]![rows[0]!.length - 1];
    if (typeof last === 'number') return last;
  }
  return find(res) ?? 0;
}

async function agg(mcp: SigNozMcp, params: Record<string, unknown>): Promise<number> {
  return scalar(await mcp.call('aggregate_traces', { requestType: 'scalar', ...params }));
}

const NS_PER_MS = 1_000_000;

export async function analyzeSlo(
  mcp: SigNozMcp,
  service: string,
  operation: string,
  timeRange = '6h',
): Promise<SloEvidence> {
  const base = { service, operation, timeRange };
  const total = await agg(mcp, { aggregation: 'count', ...base });
  const errors = await agg(mcp, { aggregation: 'count', error: true, ...base });
  const p50Ns = await agg(mcp, { aggregation: 'p50', aggregateOn: 'duration_nano', ...base });
  const p95Ns = await agg(mcp, { aggregation: 'p95', aggregateOn: 'duration_nano', ...base });
  const p99Ns = await agg(mcp, { aggregation: 'p99', aggregateOn: 'duration_nano', ...base });
  const successPct = total > 0 ? ((total - errors) / total) * 100 : 0;
  return { service, operation, windowLabel: timeRange, total, errors, successPct, p50Ns, p95Ns, p99Ns };
}

/** propose a target just above observed: round p95 up to a clean ms threshold, 99%/30d default */
export async function proposeSlo(mcp: SigNozMcp, ev: SloEvidence): Promise<SloProposal> {
  // clean latency threshold ~ p95 rounded up to a nice number (ms)
  const p95Ms = ev.p95Ns / NS_PER_MS;
  const latencyThresholdMs = niceCeil(p95Ms);
  // % under threshold, to sanity-check achievability
  const under = await agg(mcp, {
    aggregation: 'count', service: ev.service, operation: ev.operation,
    maxDuration: String(latencyThresholdMs * NS_PER_MS), timeRange: ev.windowLabel,
  });
  const pctUnderThreshold = ev.total > 0 ? (under / ev.total) * 100 : 0;
  // objective just below observed good-rate (both success and latency), floored to a sensible tier
  const observedGood = Math.min(ev.successPct, pctUnderThreshold);
  const objectivePct = objectiveTier(observedGood);
  const windowDays = 30;
  const budgetHoursPerWindow = ((100 - objectivePct) / 100) * windowDays * 24;
  const reasoning =
    `Over the last ${ev.windowLabel}, ${ev.operation} served ${ev.total} requests: ` +
    `${ev.successPct.toFixed(1)}% success, p95 ${p95Ms.toFixed(0)}ms, ` +
    `${pctUnderThreshold.toFixed(1)}% under ${latencyThresholdMs}ms. ` +
    `Proposing ${objectivePct}% good (success AND < ${latencyThresholdMs}ms) over ${windowDays}d — ` +
    `achievable given history, tight enough to matter (~${budgetHoursPerWindow.toFixed(1)}h degraded/month allowed).`;
  return { service: ev.service, operation: ev.operation, objectivePct, latencyThresholdMs, windowDays, reasoning, budgetHoursPerWindow, evidence: { ...ev, pctUnderThreshold } };
}

function niceCeil(ms: number): number {
  const steps = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000];
  return steps.find((s) => s >= ms) ?? Math.ceil(ms / 1000) * 1000;
}
function objectiveTier(observedGoodPct: number): number {
  // pick the highest standard tier at or below observed (leave headroom)
  for (const t of [99.9, 99.5, 99, 98, 95, 90]) if (t <= observedGoodPct) return t;
  return 90;
}

// ---- deeper analysis (not a single pass): trend + SRE-grounded reasoning ------------

/** compare recent latency to the baseline window — is the operation stable, degrading, or improving? */
export async function latencyTrend(mcp: SigNozMcp, service: string, operation: string): Promise<SloAnalysis['trend']> {
  const recent = await agg(mcp, { aggregation: 'p95', aggregateOn: 'duration_nano', service, operation, timeRange: '1h' });
  const older = await agg(mcp, { aggregation: 'p95', aggregateOn: 'duration_nano', service, operation, timeRange: '6h' });
  const recentP95Ms = recent / NS_PER_MS, olderP95Ms = older / NS_PER_MS;
  const verdict: SloAnalysis['trend']['verdict'] = recentP95Ms > olderP95Ms * 1.2 ? 'degrading' : recentP95Ms < olderP95Ms * 0.8 ? 'improving' : 'stable';
  return { windowLabel: 'recent 1h vs 6h', recentP95Ms, olderP95Ms, verdict };
}

// Grounded in SigNoz's SRE/SLO guides (slo-vs-sla, sre-best-practices): SLI reflects user experience;
// SLO is set FROM observed performance (never 100%) and leaves an error budget; SLA is a stricter
// contract; pick the binding constraint (availability vs latency); low traffic → window-based; alert
// on burn rate. The reasoning is LLM so it can EXPLAIN the operation and weigh alternatives — a real
// analysis step before proposing, not the raw heuristic alone.
const SLO_SYSTEM = `You are a senior SRE defining a Service Level Objective. You are given live evidence for one operation and a heuristic proposal; produce a rigorous, teachable analysis. Ground everything in SRE principles:
- SLI = a metric reflecting USER experience: availability = good/total; latency = % of requests under a threshold.
- SLO = target on an SLI over a window. Set it FROM OBSERVED performance with headroom; NEVER 100%. The gap to 100% is the error budget — the allowed unreliability that funds change.
- SLA is a CONTRACT with consequences; an internal SLO should be STRICTER than any SLA (safety buffer).
- Choose the BINDING constraint: if errors are ~0 but latency is high, a LATENCY SLO matters more than availability; if both matter, say "both".
- Low traffic (roughly < a few req/s) makes request-based SLOs noisy — recommend a window-based framing and say so.
- Prefer BURN-RATE alerting (how fast the budget is consumed) over static breach alerts.
Explain the operation in plain terms from its name + observed RED metrics. Weigh 2-3 alternatives with tradeoffs. Be concrete and cite the numbers you were given.
Output ONLY a JSON object, no prose, no code fences:
{"operationExplanation":"...","sliType":"availability|latency|both","sliDefinition":"good = ...","reasoning":"...","errorBudget":"...","alternatives":[{"label":"...","note":"..."}],"sreNotes":["..."]}`;

export async function analyzeSloReasoning(ev: SloEvidence, proposal: SloProposal, trend: SloAnalysis['trend']): Promise<SloAnalysis> {
  const fallback: SloAnalysis = {
    operationExplanation: `${proposal.operation} on ${proposal.service}.`,
    sliType: ev.successPct >= 99.9 ? 'latency' : 'both',
    sliDefinition: `good = has_error=false AND duration < ${proposal.latencyThresholdMs}ms`,
    reasoning: proposal.reasoning,
    errorBudget: `${proposal.budgetHoursPerWindow.toFixed(1)}h degraded / ${proposal.windowDays}d`,
    alternatives: [], sreNotes: [], trend,
  };
  try {
    const llm = new ChatOpenAI({ model: process.env.LLM_MODEL ?? 'gpt-5.6-terra', apiKey: process.env.OPENAI_API_KEY });
    const user = JSON.stringify({
      service: proposal.service, operation: proposal.operation,
      evidence: {
        windowLabel: ev.windowLabel, requests: ev.total, errors: ev.errors, successPct: ev.successPct,
        p50Ms: ev.p50Ns / NS_PER_MS, p95Ms: ev.p95Ns / NS_PER_MS, p99Ms: ev.p99Ns / NS_PER_MS,
        pctUnderThresholdMs: ev.pctUnderThreshold, callRatePerSec: ev.total / 21600,
      },
      heuristicProposal: { objectivePct: proposal.objectivePct, latencyThresholdMs: proposal.latencyThresholdMs, windowDays: proposal.windowDays },
      latencyTrend: trend,
    });
    const resp = await llm.invoke([{ role: 'system', content: SLO_SYSTEM }, { role: 'user', content: user }] as never);
    const text = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const cleaned = text.replace(/```json?/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<SloAnalysis>;
    return {
      operationExplanation: parsed.operationExplanation ?? fallback.operationExplanation,
      sliType: parsed.sliType ?? fallback.sliType,
      sliDefinition: parsed.sliDefinition ?? fallback.sliDefinition,
      reasoning: parsed.reasoning ?? fallback.reasoning,
      errorBudget: parsed.errorBudget ?? fallback.errorBudget,
      alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives.slice(0, 3) : [],
      sreNotes: Array.isArray(parsed.sreNotes) ? parsed.sreNotes.slice(0, 5) : [],
      trend,
    };
  } catch { return fallback; }
}

// ---- apply: SLI/budget dashboard + fast-burn alert ---------------------

const good = (op: string, thrNs: number) =>
  `name = '${op}' AND has_error = false AND duration_nano < ${thrNs}`;
const totalFilter = (op: string) => `name = '${op}'`;

export function buildSloDashboard(p: SloProposal): Record<string, unknown> {
  const thrNs = p.latencyThresholdMs * NS_PER_MS;
  const sliQ = (name: string, disabled: boolean, filter: string) => ({
    queryName: name, expression: name, dataSource: 'traces', stepInterval: 60,
    aggregations: [{ expression: 'count()' }], filter: { expression: filter },
    groupBy: [], orderBy: [], selectColumns: [], functions: [], reduceTo: 'avg', disabled,
  });
  const sliFormula = (expr: string, legend: string) => ({
    queryName: 'F1', expression: expr, dataSource: 'traces', stepInterval: 60,
    aggregations: [], groupBy: [], orderBy: [], selectColumns: [], functions: [], legend, reduceTo: 'avg', disabled: false,
  });
  const widget = (id: string, title: string, panelTypes: string, queryData: unknown[], queryFormulas: unknown[], yAxisUnit: string, thresholds: unknown[] = []) => ({
    id, title, description: '', panelTypes, nullZeroValues: 'zero', opacity: '1',
    timePreferance: 'GLOBAL_TIME', yAxisUnit, selectedLogFields: [], selectedTracesFields: [],
    thresholds, contextLinks: { linksData: [] },
    query: { id: `q-${id}`, queryType: 'builder', promql: [], clickhouse_sql: [], builder: { queryData, queryFormulas } },
  });
  const O = p.objectivePct;
  return {
    title: `SLO — ${p.service} / ${p.operation} (${O}% < ${p.latencyThresholdMs}ms / ${p.windowDays}d)`,
    description: `Otto SLO copilot. ${p.reasoning}`,
    tags: ['otto', 'slo', p.service],
    variables: {},
    layout: [
      { i: 'sli-now', x: 0, y: 0, w: 6, h: 4 }, { i: 'budget-now', x: 6, y: 0, w: 6, h: 4 },
      { i: 'sli-time', x: 0, y: 4, w: 12, h: 6 }, { i: 'p95-time', x: 0, y: 10, w: 12, h: 6 },
    ],
    widgets: [
      widget('sli-now', 'Current SLI %', 'value',
        [sliQ('A', true, good(p.operation, thrNs)), sliQ('B', true, totalFilter(p.operation))],
        [sliFormula('(A/B)*100', 'SLI %')], 'percent',
        [{ index: 't0', thresholdValue: O, thresholdOperator: '<', thresholdFormat: 'Background', thresholdColor: '#E24B4A', thresholdUnit: 'percent' }]),
      widget('budget-now', 'Error Budget Remaining %', 'value',
        [sliQ('A', true, good(p.operation, thrNs)), sliQ('B', true, totalFilter(p.operation))],
        [sliFormula(`((A/B)*100 - ${O}) * ${(100 / (100 - O)).toFixed(3)}`, 'Budget %')], 'percent',
        [{ index: 't0', thresholdValue: 20, thresholdOperator: '<', thresholdFormat: 'Background', thresholdColor: '#EF9F27', thresholdUnit: 'percent' }]),
      widget('sli-time', `SLI % over time (target ${O}%)`, 'graph',
        [sliQ('A', true, good(p.operation, thrNs)), sliQ('B', true, totalFilter(p.operation))],
        [sliFormula('(A/B)*100', 'SLI %')], 'percent',
        [{ index: 't0', thresholdValue: O, thresholdOperator: '<', thresholdFormat: 'Text', thresholdColor: '#E24B4A', thresholdUnit: 'percent' }]),
      widget('p95-time', `p95 latency (target < ${p.latencyThresholdMs}ms)`, 'graph',
        [{ queryName: 'A', expression: 'A', dataSource: 'traces', stepInterval: 60, aggregations: [{ expression: 'p95(duration_nano)' }], filter: { expression: totalFilter(p.operation) }, groupBy: [], orderBy: [], selectColumns: [], functions: [], legend: 'p95', disabled: false }],
        [], 'ns',
        [{ index: 't0', thresholdValue: thrNs, thresholdOperator: '>', thresholdFormat: 'Text', thresholdColor: '#E24B4A', thresholdUnit: 'ns' }]),
    ],
  };
}

// SigNoz create_alert (v2alpha1 threshold_rule). Shape mirrors the canonical
// `traces_error_rate_formula` payload from signoz://alert/examples (PR #11023):
//   • `evaluation` is TOP-LEVEL, not under `condition` (condition is additionalProperties:false —
//     nesting it there was the client-side zod parse failure we hit first).
//   • formula component queries A/B are `disabled:true` so only F1 renders in the notification.
//   • NO `order`/`limit` on the persisted specs — those belong to the dry-run execution step, not
//     the create payload; including `order:__result` here draws a server-side 400.
//   • channels live in `thresholds.spec[].channels` (per-tier routing); no top-level preferredChannels.
//   • threshold in the user's unit (percent); op `below` + at_least_once catches any fast-burn dip.
export function buildSloAlert(p: SloProposal, channel: string): Record<string, unknown> {
  const thrNs = p.latencyThresholdMs * NS_PER_MS;
  return {
    alert: `SLO fast-burn — ${p.service}/${p.operation} (SLI < ${p.objectivePct}%)`,
    alertType: 'TRACES_BASED_ALERT', ruleType: 'threshold_rule', version: 'v5', schemaVersion: 'v2alpha1',
    description: `Fires when ${p.operation} SLI drops below the ${p.objectivePct}% objective. Otto SLO copilot.`,
    labels: { severity: 'critical', service: p.service, slo: `${p.service}-${p.operation}` },
    annotations: {
      summary: `${p.service}/${p.operation} SLI {{$value}}% below ${p.objectivePct}% objective`,
      description: `SLI for ${p.operation} dropped to {{$value}}% (objective {{$threshold}}%). Error budget is burning — inspect recent latency/errors for ${p.service}. Otto SLO copilot.`,
    },
    condition: {
      selectedQueryName: 'F1',
      compositeQuery: {
        queryType: 'builder', panelType: 'graph', unit: 'percent',
        queries: [
          { type: 'builder_query', spec: { name: 'A', signal: 'traces', stepInterval: 60, disabled: true, aggregations: [{ expression: 'count()' }], filter: { expression: good(p.operation, thrNs) } } },
          { type: 'builder_query', spec: { name: 'B', signal: 'traces', stepInterval: 60, disabled: true, aggregations: [{ expression: 'count()' }], filter: { expression: totalFilter(p.operation) } } },
          { type: 'builder_formula', spec: { name: 'F1', expression: '(A / B) * 100', legend: 'SLI %' } },
        ],
      },
      // recoveryTarget is required by the MCP tool's zod schema (stricter than the raw API, which omits it)
      thresholds: { kind: 'basic', spec: [{ name: 'critical', op: 'below', matchType: 'at_least_once', target: p.objectivePct, recoveryTarget: null, targetUnit: 'percent', channels: [channel] }] },
    },
    evaluation: { kind: 'rolling', spec: { evalWindow: '15m', frequency: '1m' } },
  };
}

export async function applySlo(mcp: SigNozMcp, p: SloProposal, channel?: string): Promise<{ dashboardId?: string; alertCreated: boolean; alertError?: string }> {
  const dash = buildSloDashboard(p);
  const created = await mcp.call<{ data?: { id?: string }; id?: string }>('create_dashboard', dash);
  const dashboardId = created?.data?.id ?? created?.id;
  let alertCreated = false;
  let alertError: string | undefined;
  if (channel) {
    try {
      await mcp.call('create_alert', buildSloAlert(p, channel));
      alertCreated = true;
    } catch (e) {
      alertError = (e as Error).message.slice(0, 160); // don't lose the dashboard over the alert
    }
  }
  return { dashboardId, alertCreated, alertError };
}
