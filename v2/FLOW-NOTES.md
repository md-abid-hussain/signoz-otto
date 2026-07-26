# FLOW-NOTES — Manual migration run via SigNoz MCP (2026-07-25)

> The agent-loop spec, derived by doing the whole flow by hand. Every friction point here is a requirement for the agent. Companion to [PRODUCT.md](PRODUCT.md).

## What was done (end-to-end, all via MCP + shell)

Migrated the OTel demo's **"Spanmetrics Demo Dashboard"** (Grafana, 7 query panels) into SigNoz — readiness → grounding → translation → validation → side-by-side fidelity proof → dashboard creation.

**Result (run 1, superseded):** SigNoz dashboard `019f97e0-…` "Spanmetrics Demo (Migrated from Grafana)" with 3 validated panels (call rate, error rate, p95 latency). **This partial dashboard was deleted in run 2**, replaced by the full 7-panel migration (`019f9802-…`). See "Run 2" below.

## Environment facts (demo stack)

- OTel demo v3 splits backends into `compose.observability.yaml` (Grafana/Prometheus/Jaeger/OpenSearch not in base compose). Port moved: `ENVOY_PORT=8081` + `PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` in `.env` (SigNoz owns 8080).
- Dual-export via `src/otel-collector/otelcol-config-extras.yml` (file documents exact upstream exporter names to repeat; **arrays replace, maps merge**).
- Gotchas hit: (1) `host.docker.internal` resolves **IPv6-only** here → gRPC "network unreachable" → fixed by `docker network connect signoz-network otel-collector` + endpoint `signoz-ingester-1:4317` (⚠️ network connect does not survive container re-creation — product compose must declare the network properly). (2) SigNoz ingester rejects >4MB gRPC messages; demo pipelines have **no batch processor** → added `batch/split` (send_batch_max_size 1500) to metrics pipeline in extras.
- Exporter type names in this collector build: `otlp_grpc/...`, `otlp_http/...` (renamed from `otlp`/`otlphttp`).

## The validated mapping (readiness output)

| Grafana artifact | SigNoz reality | How found |
|---|---|---|
| `traces_span_metrics_calls_total` | `traces.span.metrics.calls` (cumulative sum) | `list_metrics` search "calls" |
| `traces_span_metrics_duration_milliseconds_{bucket,sum,count}` | `traces.span.metrics.duration.{bucket,sum,count}` (unit `ms` in metadata) | search "span.metrics" |
| label `service_name` | `service.name` — **exists in BOTH resource and attribute contexts** | `get_field_keys(metricName=...)` |
| label `span_name` | `span.name` (attribute) | same |
| label `status_code` | `status.code` (attribute); value `STATUS_CODE_ERROR` unchanged | same |
| — decision — | `signoz_calls_total` also exists (SigNoz's own trace-derived spanmetrics, delta) — **two candidates for one source metric**; chose `traces.span.metrics.*` for fidelity-to-source; record as judgment | |

Rename pattern (agent heuristic): Prometheus name = OTel name with dots→underscores, `_total` appended to counters, unit (`_milliseconds`) embedded in name; reverse to map back.

## Friction log → agent requirements

| # | What happened | Agent requirement |
|---|---|---|
| F1 | `order: [{key:{name:"A"}}]` → 400 "invalid order by key" | For top-N: omit `order`, keep `limit` (limit implies value-desc per docs). Keep 400-repair loop. |
| F2 | `requestType: "scalar"` → success but `aggregations: null` despite 16k rows scanned | Validate with `time_series`; treat scalar as display-only concern. |
| F3 | Guessed epoch timestamps were 40 min stale → empty window | Agent must fetch wall-clock time programmatically, never estimate. |
| F4 | **groupBy on ambiguous `service.name` (no fieldContext) → HTTP 200, rows scanned, `aggregations: null`. No error.** | The killer silent failure. Readiness MUST fetch field keys + contexts per metric BEFORE translation, and every groupBy/filter key MUST carry explicit `fieldContext`. Validation MUST treat `aggregations:null` as FAIL even on 200. |
| F5 | Histogram percentile (`spaceAggregation: p95` on any `.bucket` metric) → **HTTP 500**, on cumulative AND delta histograms — broken/different in this build despite being the documented API example | Per-archetype fallback ladder. For span-latency percentiles: fallback #1 = traces-signal `p95(duration_nano)` (native, validated, arguably better); fallback #2 = PromQL panel passthrough (quoted-name selector form). Record fallback + reason in panel notes. |
| F6 | 500 vs 400 need different repair | 400 → repair shape and retry; 500 → don't retry same shape, switch strategy (different signal/query type). Cap attempts. |
| F7 | Widget-create schema wants all three query containers (`promql`, `clickhouse_sql`, `builder`) present per widget + `layout` as sibling of `widgets` | Serializer must emit full envelope; reuse this run's created dashboard JSON as the golden template. |

## Fidelity evidence (panel 1: top-7 service call rate)

Same 30-min window, SigNoz builder query vs Prometheus `topk(7, sum by (service_name)(rate(traces_span_metrics_calls_total[30m])))`:

| Service | Prometheus req/s | SigNoz req/s (bucket avg) |
|---|---|---|
| frontend-proxy | 15.53 | ~15–18 ✓ |
| frontend | 14.92 | ~15–17 ✓ |
| flagd | 10.42 | ~10–12 ✓ |
| frontend-web | 7.36 | ~7–8 ✓ |
| product-catalog | 5.83 | ~5.5–7 ✓ |
| cart | 2.65 | ~2.6–4 ✓ |
| load-generator | 2.01 | ~2–2.4 ✓ |

Identical membership, identical ranking, matching magnitudes. **This table is the product's core screenshot.**

Error-rate panel validated too: sparse errors on payment/ad/flagd/recommendation (~0.008/s) — consistent with `list_services` error counts.

## Confirmed agent pipeline (revised from DESIGN v1 §4)

```
fetch clock → readiness (list_metrics + get_field_keys per referenced metric — MANDATORY, feeds F4)
→ deterministic map (golden table) → agent gap-fill (renames via heuristic + candidate choice F7)
→ validate: execute time_series; PASS = non-null aggregations with plausible series; 200+null = FAIL (F4)
→ repair: 400→fix shape; empty→recheck grounding; 500→fallback ladder (F5/F6); ≤2 attempts each
→ assemble widgets (golden template from this run) → create_dashboard → link
```

## Run 2 (2026-07-25): FULL dashboard migration — findings

Complete Spanmetrics dashboard migrated per RUNBOOK.md: **7/7 query panels, 14 targets, 0 silently dropped.** Created as `019f9802-8df2-728d-8beb-5a818ea9023f` "Spanmetrics Demo — Full Migration"; run-1 partial deleted (user-approved). New friction/facts:

| # | Finding | Agent requirement |
|---|---|---|
| F8 | Grafana **API export had 14 targets vs 12 in the provisioning file** — live instances drift from their sources | Always ingest from the Grafana API (or user export), never assume repo/IaC files match reality |
| F9 | Formula (`A/B`) works via `builder_formula` (query API) / `queryFormulas` (widget); **without limit it exploded to 116 series** | Formulas get explicit `limit`; widget formula entries need full queryData-like scaffolding (stepInterval, dataSource, empty arrays) — schema is strict |
| F10 | `table` panelType with 2 queries **accepted at create** (API level); rendering verified by user separately | Two-phase verification: query-time (execute) + create-time (persist) + render-time (human eyeball in review UI) |
| F11 | Quantile ceiling: SigNoz expressions support p50/p75/p90/p95/p99 — **no p999** | Unsupported-quantile rule: drop with note (never substitute silently) |
| F12 | Span intrinsic `name` groupBy in widgets: `type: "tag"` works; in query API `fieldContext: "span"` works | Context mapping differs slightly between query API and widget serialization — serializer table must cover both |
| F13 | `get_field_values` confirmed enum values (`STATUS_CODE_ERROR`) survive OTLP verbatim | Value-level readiness check is cheap and worth doing for filtered enums |
| F14 | Original dashboard had a **real bug** (span-level panel grouping 3/4 targets by service) — translated to intent, flagged as agent judgment | "Faithful-to-intent vs faithful-to-bug" is a genuine decision class; always surface it in notes |
| F15 | Long-lived streaming spans (600s EventStream) dominate latency top-Ns in both systems equally — fidelity checks agreed to the decimal (600002.2 vs 600002.6 ms) | Fidelity comparison tolerance: ~0.001% achievable on formula panels; use ranking+magnitude, not exact equality |

## Run 3 (2026-07-25): SLO copilot manual run — findings

Proposed + created an evidence-based SLO for checkout/PlaceOrder. Dashboard `019f9810-96b6-7cca-b4cf-b3c478c7ffc2` "Checkout SLO — PlaceOrder" created (4 panels). Alert `019f98e8-c52d-723d-89b5-61c44726e0ce` created, routing to Slack channel `sigboz-alert` (was briefly blocked on the channel decision — see S6/S9).

**Evidence gathering (read-only, `aggregate_traces`):** 250 orders/1h, 0 errors, p50 1.29s, p95 2.41s, p99 2.88s, 239/250 (95.6%) under 2.5s. Proposal: 95% success-under-2.5s over 30d. Method = observe distribution → pick target just above observed with small headroom → show the math.

| # | Finding | Agent requirement |
|---|---|---|
| S1 | SLI is expressible: good/total via two disabled trace counts + `builder_formula` `(A/B)*100`. Budget = `((A/B)*100 - 95)*20` also works | SLO panels are a formula-pack template; parametrize target/threshold/operation |
| S2 | **`value` panel + formula + `reduceTo:"avg"` works** (migration never tested this) | Value-panel formula pattern confirmed for SLI/budget big-numbers |
| S3 | Duration filter in trace filter expression works: `duration_nano < 2500000000` (ns literal) | "good latency" threshold expressed inline; agent converts user seconds→ns |
| S4 | Thresholds array on widgets works: `{thresholdValue, thresholdOperator, thresholdFormat:'Text'|'Background', thresholdColor(hex), thresholdUnit}` | SLO target lines are just widget thresholds |
| S5 | `aggregate_traces` warns `service.name` ambiguous (resource vs attribute), defaults to resource | Use `service`/`operation` shortcut params or fully-qualified `resource.service.name` to silence + be correct |
| S6 | **Alert create HARD-REQUIRES a notification channel** — no channel, no rule (even though rule would show firing state in UI without delivery) | SLO/alert flow must provision-or-select a channel as a step. Product-native channel = webhook → Otto itself (burn events feed the platform SLO tracker). Destination is a user decision (privacy). |
| S7 | Alert schema (v2alpha1 threshold_rule) mirrors dashboard formula query: queries A/B disabled + F1 formula, `selectedQueryName:'F1'`, `thresholds.spec[].{target,op:'below',matchType:'at_least_once'}`, `evaluation.spec.{evalWindow,frequency}` | Alert serializer reuses the SLI query pack; only the wrapper differs from a panel |
| S8 | Rolling 30-day error budget can't be shown honestly on a plain dashboard (panel shows selected range only). Budget panel here reflects dashboard time range. | True rolling-window budget = Otto platform responsibility (SigNoz has no SLO primitive) — confirms the platform/SigNoz ownership split |
| S9 | Requested `evalWindow: "15m"` but API **silently applied its 5m default** (response showed `evalWindow: "5m0s"`) — no error | Verify stage must READ BACK the created rule and diff against intent, never trust the request echo. Alert created OK, routes to Slack `sigboz-alert`. |

## Build session (2026-07-25): deterministic engine coded + live-verified

Otto's engine now reproduces the migration **automatically from our own code** (not the connector): `parse → readiness → translate → validate(live) → assemble → apply`. Created dashboard `019f99f7-31a7-7b8b-b22c-e3f500466f69` "Spanmetrics Demo Dashboard — Otto migration" — 3 rate/sum panels auto-validated (7/5/7 series) + APM table; 4 histogram/formula panels honestly skipped (agent territory). New findings:

| # | Finding | Fix |
|---|---|---|
| F16 | Metrics builder query with `temporality: "Unspecified"` returns **null aggregations despite scanning rows**; omitting temporality returns full data | Omit `temporality` from the aggregation; let the backend infer it |
| F17 | Unresolved Grafana template vars (`label=~"$service"`) translate to `REGEXP '$service'` which matches nothing → null | v1 match-all policy: drop filter clauses containing `$` (match-all vars), keep real filters (e.g. `status.code = 'STATUS_CODE_ERROR'`) |
| F18 | Dependency scanner mis-classified label keys (`service_name`) as metrics | Subtract labels from the metric set in the parser |
| F19 | Mapper doesn't handle `topk(histogram_quantile(...))` or metric/metric division → those panels are `unsupported` (deterministic) | Agent/traces-fallback territory (run-2 used traces `p95(duration_nano)`); mapper enhancement is a follow-up |

MCP-over-HTTP client (`@langchain/mcp-adapters`, `SIGNOZ-API-KEY` header) live-verified: 41 tools, results unwrap from `[{type:'text',text}]`. Run TS via `tsx` (value imports of `.js` break `node --experimental-strip-types`). 27 vitest passing (mapper, grafana parser, readiness heuristic).

## Multi-dashboard sweep (2026-07-25): where the agent is needed

Ran the deterministic engine across 6 live OTel-demo Grafana dashboards. Coverage + the agent-involvement map:

| Dashboard | Deterministic validated | Agent-translate (unsupported) | Repair (needs_review) | Genuine missing (auditor) |
|---|---|---|---|---|
| linux (host) | 15/19 | 1 | 3 | 1 |
| spanmetrics | 3 | 4 | 0 | 0 |
| demo | 3 | 2 | 4 | 3 (python runtime) |
| apm | 0 | 11 | 0 | 1 |
| postgres | 0 | 1 | 5 | 17 (not instrumented) |
| otel-collector | 4 | 22 | 19 | 18 (collector self-metrics) |

**Agent involves for:** (1) `histogram_quantile(…)` latency panels — deterministic bucket→p95 500s (F5), agent must use traces `p95(duration_nano)` fallback (most common case); (2) metric/metric ratios → two-query formula; (3) exotic funcs `timestamp()`/`target_info`/`label_replace`; (4) repair of empty/500 validations. **Agent does NOT fix `missing`** — that's the auditor honestly reporting instrumentation gaps (postgres/python/collector metrics absent from SigNoz) → suggest a collector config, not a translation.

| # | Finding | Fix |
|---|---|---|
| F20 | Dep scanner over-collected query keywords (`head`/`sort`/`where`/`stats`) and `by()` group-by labels as "metrics" → inflated `missing` | Require a separator (`_`/`.`/`:`) in metric names; extract `by()/without()/on()/ignoring()` names as labels and subtract. demo: 10 missing → 3 real. |
| — | Deterministic mapper is strong on rate/sum/count/topk (linux 79%); histogram-quantile + ratios + exotic are the agent frontier | mapper enhancement candidate: metric/metric ratio → formula (deterministic-doable); histogram latency → agent traces-fallback |

## Exercised across runs 1–3 (status)

- ✅ Formula archetype (avg latency = `rate(duration.sum)/rate(duration.count)` → `builder_formula` A/B) — run 2 (F9).
- ✅ Multi-quantile panels (p50/p95/p99 per panel) and the APM `table` panel (2 targets) — run 2 (F10, F11).
- ✅ SLO taste: `aggregate_traces` → propose target → `create_dashboard` + `create_alert` — run 3 (S1–S9).
- ⬜ **Template variables** `$service`/`$span_name` → SigNoz dashboard variables — NOT yet exercised; v1 policy = substitute fixed values / no-filter (first agent task).
- ⬜ Ask & Act conversational surface — not exercised (roadmap-minimal per DESIGN §1.1).

MCP tools exercised: `list_services`, `list_metrics`, `get_field_keys`, `get_field_values`, `execute_builder_query`, `aggregate_traces`, `create_dashboard`, `delete_dashboard`, `list_notification_channels`, `create_alert`. Auth via connector during manual runs; product passes `SIGNOZ-API-KEY` header (verified 401 without) using a single admin/write key.
