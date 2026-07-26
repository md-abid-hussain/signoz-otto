# DESIGN v1 — DashPort

> Phase 2 (Design) artifact. Grounded in the **real** SigNoz v5 schema verified 2026-07-21 against the live instance (dashboard `019f6bac…`) and the official [metrics query-range API](https://signoz.io/docs/metrics-management/query-range-api/) + [Query Builder v5 guide](https://signoz.io/docs/userguide/query-builder-v5/). Requirements in [REQUIREMENTS.md](REQUIREMENTS.md).

## 0. The single most important design fact: there are TWO v5 shapes

SigNoz uses **different JSON for querying vs. for storing a dashboard widget.** Our converter must emit both, from one internal model.

**(a) Query-range API shape** — used to VALIDATE (execute a query, `POST /api/v5/query_range`):
```jsonc
{ "type": "builder_query",
  "spec": {
    "name": "A", "signal": "metrics", "stepInterval": 60,
    "aggregations": [{ "metricName": "signoz_calls_total",
                       "timeAggregation": "rate", "spaceAggregation": "sum",
                       "temporality": "Unspecified" }],
    "filter": { "expression": "service.name = 'frontend'" },
    "groupBy": [{ "name": "service.name" }],
    "legend": "{{service.name}}", "disabled": false } }
```

**(b) Dashboard-widget shape** — used to CREATE the dashboard (stored under `widgets[].query.builder.queryData[]`):
```jsonc
{ "queryName": "A", "expression": "A", "dataSource": "metrics",
  "aggregations": [{ "metricName": "signoz_calls_total",
                     "timeAggregation": "rate", "spaceAggregation": "sum" }],
  "filter": { "expression": "service.name = 'frontend'" },
  "groupBy": [{ "key": "service.name", "dataType": "string", "type": "tag" }],
  "orderBy": [], "functions": [], "selectColumns": [], "stepInterval": 60,
  "legend": "{{service.name}}" }
```

Differences to handle: `signal` vs `dataSource`; `name` vs `queryName` (+`expression`); `groupBy[].name` vs `groupBy[].{key,dataType,type}`; query shape is wrapped in `{type,spec}` for the API but flat for the dashboard. Our internal `BuilderQuery` model is shape-agnostic; two serializers (`toQueryApi`, `toWidget`) render each. **This dual-serializer boundary is the core of the SigNoz client module.**

Both filters and `having` are **string expressions** (SQL-WHERE-like), not nested ASTs — this makes emission mostly string assembly.

## 1. The golden mapping: PromQL → metrics BuilderQuery

PromQL's `<outer-agg> by (<labels>) (<time-func>(<metric>{<matchers>}[<window>]))` decomposes 1:1 onto SigNoz's split:

| PromQL | BuilderQuery field | Example |
|---|---|---|
| metric name | `aggregations[0].metricName` | `signoz_calls_total` |
| `{label="v"}`, `{label=~"re"}` | `filter.expression` (`=`, `REGEXP`, `IN`, `!=`) | `service.name = 'frontend'` |
| `rate(...[5m])`, `increase(...)` | `timeAggregation: "rate"` / `increase` | |
| outer `sum/avg/min/max`/`count` `by (l)` | `spaceAggregation` + `groupBy[]` | `spaceAggregation: "sum"`, `groupBy:[{name:"service.name"}]` |
| `histogram_quantile(0.95, …_bucket)` | `metricName: x_bucket`, `spaceAggregation: "p95"` | |
| `topk(n, …)` / `bottomk(n, …)` | `orderBy: [count() desc]` + `limit: n` | |
| `expr > N` on an aggregate | `having.expression` | `count() > 1000` |
| `exprA / exprB`, `* 100` | second query + `builder_formula` `{expression:"A/B"}` | |
| everything else (`label_replace`, subquery, `offset`, vector matching) | → agent, closest translation, mark `needs_review` | |

This table is the deterministic mapper's whole job. It is the most-unit-tested code in the repo.

## 2. Internal data model (shared TS types)

```ts
// Grafana side (parser output)
interface PanelSpec {
  id: string; title: string;
  grafanaType: 'timeseries'|'stat'|'gauge'|'table'|string;
  targets: { refId: string; expr: string }[];   // raw PromQL
  unit?: string; thresholds?: Threshold[];
  gridPos: { x:number; y:number; w:number; h:number };
}

// Neutral SigNoz builder model (shape-agnostic; serialized two ways)
type TimeAgg = 'rate'|'increase'|'avg'|'sum'|'min'|'max'|'count'|'latest';
type SpaceAgg = 'sum'|'avg'|'min'|'max'|'count'|'p50'|'p90'|'p95'|'p99';
interface BuilderQuery {
  name: string;                 // 'A','B'
  signal: 'metrics'|'traces'|'logs';
  metricName?: string;
  timeAggregation?: TimeAgg;
  spaceAggregation?: SpaceAgg;
  filterExpr?: string;          // "service.name = 'frontend' AND ..."
  groupBy: string[];            // attribute names
  havingExpr?: string;          // "count() > 1000"
  orderBy?: { key: string; dir: 'asc'|'desc' }[];
  limit?: number;
  legend?: string;
}
interface Formula { name: string; expression: string; }  // "A/B"

// Result of converting one panel
type PanelStatus = 'validated'|'validated_with_renames'|'needs_review'|'unsupported';
interface PanelResult {
  panel: PanelSpec;
  queries: BuilderQuery[]; formulas: Formula[];
  panelType: 'graph'|'value'|'table'|'list'|'bar';
  status: PanelStatus;
  renames: { from:string; to:string; reason:string }[];
  notes: string; path: 'deterministic'|'agent';
  validation?: { seriesCount:number; sample:unknown };
}
```

## 3. Panel type mapping

| Grafana `type` | SigNoz `panelTypes` | notes |
|---|---|---|
| `timeseries`, `graph` | `graph` | **verify exact string via network tab on day 2** (dashboard sample only showed value/bar/table/list) |
| `stat` | `value` | |
| `gauge` | `value` | no native gauge; value with unit |
| `table` | `table` | |
| `barchart` | `bar` | |
| other | `value` + `unsupported` | preserve PromQL in description |

Unit passthrough: Grafana `ms`/`s`/`percent`/`bytes` → SigNoz `yAxisUnit` (`ms`,`s`,`percent`,`bytes`; ns for durations). Layout: Grafana 24-col `gridPos` → SigNoz 12-col `layout` (halve x/w, keep relative).

## 4. Component architecture & per-panel pipeline

```
parser (Grafana JSON → PanelSpec[])
  → for each panel:
      promqlParse (AST)                     [deterministic]
      → mapper (AST → BuilderQuery|gaps)    [deterministic, unit-tested]
          gaps? → agent.translate           [LLM + tools]
      → grounder (names → live instance)    [deterministic exact; agent on mismatch]
      → validator (toQueryApi → execute)    [SigNoz client]
          empty/err → agent.repair (≤2)
      → assembler (BuilderQuery → widget)   [deterministic, toWidget]
  → dashboardBuilder (widgets + layout → dashboard JSON)  [apply phase]
```

Module boundaries = folders in SPEC repo layout. `mapper`, `grounder`, `assembler` are pure/deterministic and unit-testable with no network. `agent` and `signozClient` own all I/O.

## 5. Agent contract

- **Model:** `claude-fable-5` (or `claude-sonnet-5` for cost on bulk panels — configurable).
- **Invoked only** when: mapper reports unsupported nodes, grounding finds no exact metric match, or validation fails. Deterministic panels never call the LLM.
- **Tools** (each a traced span): `list_metrics(search?)`, `get_fields(metric)`, `run_builder_query(spec, range)`, and apply-phase-only `create_dashboard`, (stretch) `create_alert_rule`.
- **Input to LLM:** one panel's parsed AST + candidate BuilderQuery + (on grounding) the shortlist of real metric names. **Never** the raw dashboard JSON, never the API key.
- **Output:** a patched `BuilderQuery` + `notes` + `renames`. Bounded: ≤2 repair loops, tool-call cap, token budget (N4).

## 6. Backend ↔ SigNoz endpoints used

- Validate/preview: `POST /api/v5/query_range` (requestType `time_series` for charts, `scalar` for stat panels).
- Metadata (grounding): metric list + field keys/values (via MCP-equivalent REST; confirm exact paths against the running instance's network tab — the UI calls them).
- Create dashboard: dashboards create API with the `{title,tags,layout,widgets,variables,version:"v5"}` body verified in section 0.
- Auth header: `SIGNOZ-API-KEY: <key>`.

## 7. Verified vs. to-confirm (honest risk register)

- ✅ Verified against live instance/docs: dashboard body shape; widget/queryData shape; metrics aggregation split (metricName/timeAggregation/spaceAggregation); filter+having as string expressions; formula shape; query-range API shape; auth header; 12-col layout.
- ⚠️ Confirm on day 2 (cheap — read the UI's network tab on the running instance): exact `panelTypes` string for timeseries (`graph`?); metric metadata REST paths; `temporality` values per metric type; scalar vs time_series requestType per panel type; dashboard-create HTTP path/verb.
- These unknowns are all **read-one-request-to-confirm**, not architectural. None block starting the mapper (pure logic).

## 8. Build order (matches SPEC milestones)

1. Shared types (§2) — encode the verified schema. ← start here, zero deps.
2. Deterministic mapper (§1) + unit tests — the risky core, no network.
3. SigNoz client with `toQueryApi`/`toWidget` serializers (§0) + validate.
4. Agent loop (§5). 5. Frontend. 6. Meta-layer. 7. (stretch) alerts.
