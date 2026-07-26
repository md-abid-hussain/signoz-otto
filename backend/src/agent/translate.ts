// Agent tail: translate panels the deterministic mapper can't (histogram latency,
// ratios, exotic funcs) into validated SigNoz v5 queries. Generate → validate(live)
// → repair (≤2). LLM = ChatOpenAI (gpt-5.6-terra) via LangChain; provider-swappable.

import { ChatOpenAI } from '@langchain/openai';
import type { PanelSpec } from '../types.js';
import type { SigNozMcp } from '../signoz/mcp.js';

export interface AgentQuery {
  name: string;
  signal: 'metrics' | 'traces';
  aggregations: { metricName?: string; expression?: string; timeAggregation?: string; spaceAggregation?: string }[];
  filter?: { expression: string };
  groupBy?: { name: string; fieldContext: string }[];
  limit?: number;
  disabled?: boolean;
  legend?: string;
}
export interface AgentResult {
  status: 'validated' | 'needs_review' | 'unsupported';
  panelType?: string;
  queries: AgentQuery[];
  formula?: { name: string; expression: string };
  variables?: string[]; // SigNoz dashboard variable field-names referenced
  notes: string;
  seriesCount?: number;
  usage?: { calls: number; inputTokens: number; outputTokens: number };
}

/** pull token usage off a LangChain response (usage_metadata) */
export function readUsage(resp: unknown): { inputTokens: number; outputTokens: number } {
  const u = (resp as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })?.usage_metadata;
  return { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0 };
}

// SYSTEM prompt distills the SigNoz signoz-generating-queries + signoz-creating-dashboards
// skills (agent knowledge): metric-type→timeAggregation, histogram→traces, ratio→formula,
// count() expression shape, template-vars→dashboard variables, legend dot-mapping.
const SYSTEM = `You convert a Grafana PromQL panel into a SigNoz Query Builder v5 query. Output ONLY a JSON object, no prose, no code fences.

SigNoz rules:
- metrics query: aggregations:[{"metricName":<name>,"timeAggregation":<t>,"spaceAggregation":<s>}]. spaceAggregation ∈ sum,avg,min,max,count,p50,p90,p95,p99. NEVER include temporality.
- timeAggregation MUST match the metric TYPE (picking rate on a gauge yields garbage):
  · counter / monotonic sum (names ending _total, .count, or wrapped in rate()/increase() in the source) → "rate" for a per-second panel, "increase" for a running total.
  · gauge (utilization, current usage, in-flight) → "avg" (or "latest" for a single-value panel). NEVER rate/increase a gauge.
  · non-monotonic sum → "sum"/"avg"/"min"/"max"; never "rate" or "latest".
  Mirror the source PromQL: rate(x[..])→rate, increase(x[..])→increase, avg/gauge→avg.
- COUNT of spans/logs (not a metric): use signal:"traces" (or "logs") with aggregations:[{"expression":"count()"}] — expression shape, no metricName. Use this for request-count / error-count panels that have no counter metric.
- LATENCY percentiles (histogram_quantile in the source): DO NOT use the *_bucket metric (it errors in this build). Instead use signal:"traces" with aggregations:[{"expression":"p95(duration_nano)"}] (map 0.5→p50,0.95→p95,0.99→p99), groupBy on service.name / span name as appropriate.
- ratio / error-rate (A/B in source): emit two queries name "A","B" with "disabled":true and a formula {"name":"F1","expression":"A/B*100"}. Prefer resource attributes (service.name) in the filters — they query fastest.
- groupBy: dotted OTel names; {"name":"service.name","fieldContext":"resource"}; other keys use "attribute". Drop 'le'.
- Grafana template-variable filters (e.g. service_name=~"$service" or "\${service:regex}") must be PRESERVED as SigNoz dashboard-variable references: rewrite to \`service.name IN $service.name\` (variable named after the OTel field) and list those field names in "variables". Do NOT drop them.
- BUT only for data-backed (query) variables that select a real field value (service.name, k8s.namespace.name, etc.). DROP optional free-text/textbox filters entirely — SigNoz has no equivalent of the Grafana "optional" idiom. Specifically, NEVER emit \`(field = $var OR $var = "")\`, \`field = $traceId\`, or any clause whose variable is a free-text box; omit that clause and do not list such a variable in "variables". An empty variable reference makes SigNoz reject the whole query.
- legend: set each query's "legend" from the panel's legendFormat, converting {{span_name}} → {{span.name}} (underscores→dots). If none, use {{<first groupBy field>}}.
- Use the provided renameMap + availableMetrics to choose real metricName values.
- If genuinely not translatable, return {"unsupported":true,"notes":"why"}.

Output JSON shape: {"panelType":"graph|value|table|bar","queries":[{"name":"A","signal":"metrics|traces","aggregations":[...],"filter":{"expression":"..."},"groupBy":[{"name":"...","fieldContext":"..."}],"legend":"{{...}}","limit":7,"disabled":false}],"formula":{"name":"F1","expression":"A/B*100"},"variables":["service.name"],"notes":"..."}`;

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function validateComposite(
  mcp: SigNozMcp,
  queries: AgentQuery[],
  formula?: { name: string; expression: string },
): Promise<{ ok: boolean; seriesCount?: number; error?: string }> {
  const now = Date.now();
  // strip unbound $variable clauses for validation (they resolve only in the live dashboard)
  const stripVars = (f?: { expression: string }): { expression: string } | undefined => {
    if (!f?.expression) return undefined;
    const kept = f.expression.split(/\s+AND\s+/i).filter((c) => !c.includes('$'));
    return kept.length ? { expression: kept.join(' AND ') } : undefined;
  };
  const specs = queries.map((q) => {
    const filter = stripVars(q.filter);
    return {
      type: 'builder_query',
      spec: {
        name: q.name, signal: q.signal, stepInterval: 60,
        aggregations: q.aggregations, disabled: q.disabled ?? false,
        ...(filter ? { filter } : {}),
        ...(q.groupBy ? { groupBy: q.groupBy } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      },
    };
  });
  if (formula) specs.push({ type: 'builder_formula', spec: { name: formula.name, expression: formula.expression, disabled: false } } as never);
  const query = {
    schemaVersion: 'v1', start: now - 3_600_000, end: now, requestType: 'time_series',
    compositeQuery: { queries: specs }, formatOptions: { formatTableResultForUI: false, fillGaps: false }, variables: {},
  };
  try {
    const res = await mcp.call<{ data?: { data?: { results?: { aggregations?: unknown[] | null }[] } } }>('execute_builder_query', { query });
    const results = res?.data?.data?.results ?? [];
    const anyData = results.some((r) => Array.isArray(r.aggregations) && r.aggregations.length > 0 && ((r.aggregations[0] as { series?: unknown[] })?.series?.length ?? 0) > 0);
    return anyData ? { ok: true, seriesCount: (results[results.length - 1]?.aggregations?.[0] as { series?: unknown[] })?.series?.length ?? 0 } : { ok: false, error: '200 but null/empty aggregations' };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 160) };
  }
}

export async function agentTranslatePanel(
  mcp: SigNozMcp,
  panel: PanelSpec,
  renames: Map<string, string>,
  availableMetrics: string[],
): Promise<AgentResult> {
  // gpt-5.6-terra only supports the default temperature (1); don't set it.
  const llm = new ChatOpenAI({ model: process.env.LLM_MODEL ?? 'gpt-5.6-terra', apiKey: process.env.OPENAI_API_KEY });
  const user = JSON.stringify({
    title: panel.title, grafanaType: panel.grafanaType, unit: panel.unit,
    targets: panel.targets.map((t) => ({ refId: t.refId, promql: t.expr, legendFormat: t.legend })),
    renameMap: Object.fromEntries(renames),
    availableMetrics: availableMetrics.slice(0, 60),
  });
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];

  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await llm.invoke(messages as never);
    const u = readUsage(resp); usage.calls++; usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens;
    const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const spec = extractJson(content);
    if (!spec) { messages.push({ role: 'user', content: 'Invalid JSON. Return ONLY the JSON object.' }); continue; }
    if (spec.unsupported) return { status: 'unsupported', queries: [], notes: String(spec.notes ?? 'agent: unsupported'), usage };

    const queries = (spec.queries as AgentQuery[]) ?? [];
    const formula = spec.formula as { name: string; expression: string } | undefined;
    if (!queries.length) return { status: 'unsupported', queries: [], notes: 'agent: no queries produced', usage };

    const v = await validateComposite(mcp, queries, formula);
    if (v.ok) {
      return { status: 'validated', panelType: String(spec.panelType ?? 'graph'), queries, formula, variables: (spec.variables as string[]) ?? [], notes: String(spec.notes ?? ''), seriesCount: v.seriesCount, usage };
    }
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: `That failed validation: ${v.error}. Return corrected JSON only.` });
  }
  return { status: 'needs_review', queries: [], notes: 'agent: attempts failed validation', usage };
}
