# RUNBOOK — Full single-dashboard migration, step by step

> The operational procedure (what PRODUCT.md's Priya story looks like as exact steps).
> Target for this run: **"Spanmetrics Demo Dashboard" — complete, from scratch** (all 7 query panels / 12 targets, including the 4 archetypes never exercised; supersedes the 3-panel partial from the first manual run).
> Status: **EXECUTED 2026-07-25** (manual run 2) — approved and completed. Actuals recorded in [FLOW-NOTES.md](FLOW-NOTES.md) "Run 2". Note: actual inventory was **14 targets** (not the 12 estimated below) — live Grafana API export drifted from the repo file (F8). Result: dashboard `019f9802-…`, 7/7 query panels, 0 silently dropped.

## Phase 0 — Preflight

| # | Step | Tool / check | Pass condition |
|---|---|---|---|
| 0.1 | Fetch wall-clock epoch ms (never guess — friction F3) | shell `python time` | got timestamp |
| 0.2 | Verify SigNoz side: services reporting recently | `signoz_list_services (30m)` | ≥10 demo services |
| 0.3 | Verify Grafana side reachable | `GET /api/search` | dashboard list returns |

## Phase 1 — Ingest the artifact

| # | Step | Detail |
|---|---|---|
| 1.1 | Pull the dashboard JSON **from Grafana's API** (`GET /api/dashboards/uid/{uid}`), not the repo file — the API export is what a real user has | Spanmetrics Demo uid from /api/search |
| 1.2 | Parse inventory: every panel (type, title, gridPos, unit), every target (refId, raw PromQL, legend), template variables | classify: 7 query panels + 1 text + 2 rows (structural) |
| 1.3 | Extract the dependency set: metrics referenced, labels used, variables used | expected: 2 metric families, 3 labels, 2 variables |

## Phase 2 — Readiness report (read-only; nothing touched)

| # | Step | Detail |
|---|---|---|
| 2.1 | For each referenced metric, search SigNoz: exact name, then rename-heuristic candidates (underscores→dots, strip `_total`, strip unit token) | `signoz_list_metrics` |
| 2.2 | For each matched metric, fetch label keys **with field contexts** — mandatory, prevents the silent-null failure (F4) | `signoz_get_field_keys(metricName=…)` |
| 2.3 | Spot-check critical label values (`status.code` = `STATUS_CODE_ERROR`?) | `signoz_get_field_values` |
| 2.4 | Multi-candidate rule (F7): prefer same-origin OTLP metric (`traces.span.metrics.*`) over SigNoz-derived (`signoz_calls_total`); record the decision + reason | |
| 2.5 | Template variables `$service`, `$span_name`: v1 policy = they're `.*` match-alls → translate to *no filter*; record | |
| 2.6 | Emit the readiness table: ✅ matched / 🔄 renamed / ❌ missing, with per-panel verdict prediction | this is Priya's Step 1 output |

## Phase 3 — Translate (panel by panel)

Deterministic golden-table mapping first; agent-judgment items flagged inline. The full panel plan:

| Panel (Grafana) | Type | Targets | Translation plan | Known risk |
|---|---|---|---|---|
| P1 "Top 3x3 Service Latency" | gauge | 4 quantiles (p50/p95/p99/p999) by service | Bucket-percentile API is broken in this build (F5, 500s) → **traces signal**: queries A=p50, B=p95, C=p99 `(duration_nano)` group by resource `service.name`; **p999 unsupported** → dropped with note | multi-query panel shape untested |
| P2 "Top 7 Services Mean Rate" | bargauge | 1 | `traces.span.metrics.calls` rate/sum, group by resource `service.name`, limit 7, **no order clause** (F1) | none — validated in run 1 |
| P3 "Top 7 Services ERROR Rate" | bargauge | 1 | same + filter `status.code = 'STATUS_CODE_ERROR'` | none — validated in run 1 |
| P4 "Top 7 span_names and Errors (APM Table)" | table | 2 | **table panel**, query A = rate by `span.name`+`service.name`, query B = same with error filter | table panelType + 2-query shape untested |
| P5 "Top 3x3 span_name Latency" | gauge | 4 quantiles by span_name | same as P1 but group by span intrinsic `name` | groupBy on span-context field untested |
| P6 "Top 7 Highest Endpoint Latencies" | bargauge | 1 (ratio) | **formula archetype**: A = rate `traces.span.metrics.duration.sum`, B = rate `duration.count`, F1 = `A/B`, group by `span.name`+`service.name` | formula shape untested; fallback = traces `avg(duration_nano)` |
| P7 "Top 7 Latencies Over Range" | timeseries | 1 (ratio) | same formula as P6, graph panel | same |
| Text banner + 2 row headers | structural | — | skipped with note (no SigNoz equivalent; rows become layout ordering) | |

## Phase 4 — Validate (every query, live)

| # | Step | Rule |
|---|---|---|
| 4.1 | Execute each translated query (`requestType: time_series`, real clock window, last 30–60m) | `signoz_execute_builder_query` |
| 4.2 | PASS = 200 **and** non-null aggregations **and** ≥1 series **and** plausible magnitude. **200-with-null = FAIL** → recheck grounding/contexts (F4) | |
| 4.3 | Repair ladder: 400 → fix shape, retry (≤2). 500 → don't retry same shape; switch strategy (traces signal / different aggregation) (F5/F6). Still failing → `needs_review`, best attempt preserved | |
| 4.4 | Fidelity spot-check on ≥2 panels: same query to Prometheus, compare membership/ranking/magnitude | curl :9090 |
| 4.5 | Record per-panel status: `validated` / `validated_with_renames` / `needs_review` / `unsupported` + notes | nothing silently dropped |

## Phase 5 — Assemble & apply (approval-gated)

| # | Step | Detail |
|---|---|---|
| 5.1 | Build the full dashboard JSON: one widget per panel **including** needs_review/unsupported ones (original PromQL preserved in widget descriptions); layout mirrors Grafana gridPos (24-col → 12-col); migration notes in dashboard description | golden template = run-1 created dashboard |
| 5.2 | **STOP — present the per-panel summary table for approval** (the HITL gate from PRODUCT.md) | user says apply / changes |
| 5.3 | On approval: `signoz_create_dashboard`; also propose deleting the run-1 partial dashboard (superseded) — separate approval | |

## Phase 6 — Verify & receipts

| # | Step | Detail |
|---|---|---|
| 6.1 | Re-fetch created dashboard (`signoz_get_dashboard`) — confirm persisted shape | |
| 6.2 | Side-by-side eyeball: SigNoz dashboard vs Grafana original (user) | |
| 6.3 | Score the run: N validated / renamed / needs_review / unsupported out of 7 panels, 12 targets | Priya's Step 4 receipt, manual edition |
| 6.4 | Append new friction findings to FLOW-NOTES.md (expected: formula shape, table panel, multi-query panels, span-context groupBy) | these become agent acceptance tests |

## Expected outcome

A complete "Spanmetrics Demo (Migrated)" dashboard — 7 panels, honest statuses, at minimum P2/P3 fully validated, P1/P5 as multi-percentile traces panels with p999 documented as dropped, P4/P6/P7 exercising the untested archetypes (their failures, if any, are *wanted* — each becomes an agent requirement).
