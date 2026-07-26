# Plan v1 — SigNoz Hackathon

> **Status:** current plan (v1) · **Date:** 2026-07-20 · **Hackathon:** [Agents of SigNoz](https://www.wemakedevs.org/hackathons/signoz) (July 20–26, 2026)
>
> Concrete build spec + revised milestones (Jul 21 start): [SPEC.md](SPEC.md). Where they disagree, SPEC wins.

## The idea

**AI Dashboard Migration Agent** — a full-stack agent application that converts Grafana dashboards (PromQL/LogQL) into working, validated SigNoz dashboards.

Working name ideas: **DashPort** / **PromPilot** / **Defector** (pick later, doesn't matter yet).

A user pastes a Grafana dashboard JSON (or raw PromQL queries). An agent — not a one-shot LLM call — converts it panel by panel into SigNoz **Builder Queries**, grounds itself against the *live* connected SigNoz instance, validates its own output by executing the queries, self-corrects, and creates the finished dashboard in SigNoz via API.

## Track & positioning

- **Track 02: Signals & Dashboards** (iPad Air) — judged on OTel instrumentation depth + Query Builder mastery.
- Directly hits board card [PromQL → BuilderQuery Conversion (#11673)](https://github.com/SigNoz/signoz/issues/11673) and showcases all five Query Builder cards: Search (#11674), Aggregations (#11675), Group By (#11676), Having (#11677), Order By + Limit (#11678).
- Strategic bet: Track 01 (AI observability) will be flooded with "chat with your logs" clones. Track 02 is less crowded, and an AI app is still allowed — the *judged substance* here is instrumentation + Query Builder, which this project is soaked in.
- Why judges (SigNoz employees) will care: migration off Grafana is SigNoz's #1 adoption blocker. This is commercially existential for them, not a toy.

## Why this doesn't already exist (competitive check, 2026-07-21)

SigNoz's own [Grafana migration docs](https://signoz.io/docs/migration/migrate-from-grafana/dashboards/) cover the *data plane* well (redirect metrics/logs/traces pipelines), but for dashboards their official runbook is manual: *"Grafana dashboards need to be recreated in SigNoz due to differences in the dashboard JSON schemas between the platforms."* The documented path is (1) search the [dashboard templates repo](https://github.com/SigNoz/dashboards) for a match, (2) otherwise rebuild each panel by hand in Query Builder. **No automated converter exists** — and board card #11673 shows they want one. Our agent automates their own runbook.

Counterargument to pre-empt (judges will ask): SigNoz panels *can* run raw PromQL directly (panel query types: Builder / ClickHouse SQL / PromQL). Why convert to Builder Query at all?

1. Pasted PromQL breaks silently when metric names/labels differ — e.g. after re-instrumenting with OTel, `http_request_duration_seconds` becomes `http.server.request.duration` (OTel semantic conventions). Grounding + validation against the live instance is needed either way — that's our agent's core.
2. Dashboard JSON schemas differ regardless — panels, layout, units, thresholds, variables all need conversion even if queries were pasted.
3. Builder Query is SigNoz's first-class path (explorer handoff, alert rules, cross-signal consistency); PromQL panels are a compatibility shim. The hackathon card asks for BuilderQuery conversion specifically.

Optional nice touch (only if time): agent step 0 = search the official templates repo, and if a match exists, import + validate it — mirroring SigNoz's documented runbook exactly, then improving on it.

## How it works (agent loop)

1. **Parse** — ingest Grafana dashboard JSON: extract panels, PromQL/LogQL queries, template variables, units, thresholds.
2. **Ground** — for each panel, resolve metric names against the actual SigNoz instance (list metrics, field keys/values via SigNoz API/MCP), because names rarely match 1:1.
3. **Translate (hybrid)** — deterministic typed mapper first for mechanical constructs (selector → metric, label matchers → filters, `sum by` → aggregation + group by, comparisons → having, `topk` → order by + limit; unit-tested). The agent only handles what rules can't: semantic metric-name matching, exotic constructs (`label_replace`, subqueries, offset, query math) via closest-translation fallbacks, and repair after failed validation. Note: hackathon issue #11673 has no spec (empty body, "inspiration only") — hybrid is our choice on engineering merit and is the anti-slop story.
4. **Validate** — execute the Builder Query against SigNoz, compare shape/values against the PromQL result. Empty or wrong → self-correct and retry (bounded retries).
5. **Create** — build the dashboard in SigNoz via API. UI shows per-panel status: original panel ↔ converted query ↔ live data preview, with a confidence/status badge.

### The meta-layer (this is what wins "Best Use of SigNoz")

Instrument the agent itself with OpenTelemetry, flowing into the same SigNoz:

- **Traces** — one trace per migration; spans per panel, per LLM call, per validation retry.
- **Metrics** — token usage, LLM cost per migration, panel success rate, retry counts.
- **Logs** — structured logs correlated to traces.
- **Dashboards** — a "migration agent ops" dashboard built from the above.
- **Alerts** — e.g. "panel failure rate > 20%" or "LLM cost per migration > $X".

All five pillars touched: traces, metrics, logs, dashboards, alerts.

## Stack

One language end-to-end, no microservices (7 days, depth of spans > number of services):

| Layer | Choice |
|---|---|
| Frontend | React + Vite, shadcn/ui, TanStack Query, react-hook-form + zod |
| Backend | Node + TypeScript (Fastify or Hono), agent loop with Anthropic SDK |
| Telemetry | `@opentelemetry/auto-instrumentations-node` + manual spans for agent steps |
| Observability | SigNoz self-hosted (Docker Compose) |
| Demo data source | OpenTelemetry demo app (Astronomy Shop) → SigNoz |

Fallback: Python FastAPI backend if it turns out faster — but stay single-service either way.

## Demo script (~2 min, record on day 7)

1. Astronomy Shop is running, telemetry flowing into SigNoz.
2. Open the app, paste a well-known community Grafana dashboard JSON for that data.
3. Watch the agent convert panel by panel — live status badges, one panel fails validation and visibly self-corrects.
4. Open the finished dashboard in SigNoz next to the Grafana original — same data, side by side.
5. Flip to the "migration agent ops" dashboard: the trace of the migration we just ran, cost metrics, the alert rule.

## Day-by-day

| Day | Date | Goal |
|---|---|---|
| 1 | Jul 20 | Scaffold repo, Docker Compose (SigNoz + OTel demo app), verify data flows. Study SigNoz dashboard JSON schema + Builder Query API by hand-writing one dashboard. |
| 2 | Jul 21 | Grafana JSON parser + Builder Query types. First hardcoded (non-AI) PromQL→Builder conversion for 2–3 simple panel types, created via API. |
| 3 | Jul 22 | Agent loop: LLM translation + grounding against live metric names + execute-and-validate + retry. CLI-driven is fine, no UI yet. |
| 4 | Jul 23 | Frontend: paste/upload → migration run view with per-panel status, diff view, live preview. |
| 5 | Jul 24 | OTel instrumentation of the agent itself; build the ops dashboard + alert in SigNoz. Widen panel-type coverage. |
| 6 | Jul 25 | Polish + hardening: edge-case dashboards, empty-state UX, error handling. Freeze features. |
| 7 | Jul 26 | README (architecture diagram, criteria mapping), demo video, submission. **No new code.** |

Daily: post progress on social tagging @wemakedevs + SigNoz (Social Buzz track — cheap points, free swag).

## Judging criteria mapping

| Criterion | Our answer |
|---|---|
| Potential Impact | Solves SigNoz's real adoption blocker (Grafana migration) |
| Creativity | Agentic migration with self-validation — not another chat-with-logs bot |
| Technical Excellence | Grounded agent loop, typed Builder Query generation, bounded retries |
| Best Use of SigNoz | All 5 pillars + Query Builder surface exercised end-to-end |
| User Experience | Diff view with per-panel confidence — you can *trust* the migration |
| Presentation | Scripted 2-min demo, day 7 reserved entirely for it |

## Scope guardrails (what we cut first if behind)

1. Cut: LogQL support → PromQL only.
2. Cut: exotic panel types → support timeseries, stat, gauge, table only.
3. Cut: Grafana template variables → static queries only.
4. **Never cut:** the validate-and-retry loop (the "not slop" core) and the self-instrumentation meta-layer (the track's substance).

## Query Builder card coverage (Track 02 scoring map)

Cards #11674–#11678 are detailed showcase prompts (unlike empty #11673). Coverage plan — curate the demo Grafana dashboard so every construct appears, and use the agent's own ops dashboard for log-native asks no PromQL dashboard can produce:

| Card | Asks for | Migration demo covers | Agent ops dashboard covers |
|---|---|---|---|
| #11674 Search | boolean filters, EXISTS, JSON body paths, regex, arrays | label matchers → filters | `body.retry_count > 2`, `EXISTS trace_id` on agent logs |
| #11675 Aggregations | rate, sumIf, count_distinct, percentiles | `rate()`, `histogram_quantile` → p99 panels | token/cost sums, count_distinct panels migrated |
| #11676 Group By | mixed resource + attribute grouping | `sum by (service, route)` panels | agent logs grouped by panel + validation status |
| #11677 Having | post-aggregation group filters | PromQL comparison exprs | `count() > N` on retry groups |
| #11678 Order By + Limit | top-N / bottom-N ranking | `topk`/`bottomk` → order by + limit | slowest migration steps top-N |

README gets this table with links — literal proof of "showcase Query Builder capabilities."

## Stretch goals (strict order — touch only if on schedule by day 5)

1. **Alert rule migration** — Grafana/Prometheus alerting rules (PromQL + threshold + duration YAML) → SigNoz alert rules via API. Same agent loop, one query per rule, no layout. Pitch upgrade: "we migrate your dashboards *and* your pager." Also fills the alerts pillar with real migrated content.
2. Template variables inside dashboards (upgrade from cut-list).

**README roadmap only (do not build):** LogQL panels, Datadog/New Relic dashboard sources (same agent, different parser head — shows the architecture generalizes across SigNoz's whole migration index), recording rules. Include an honest "known limitations" section.

Why no converter exists and an agent works: dashboard migration has an unbounded long tail (naming drift, author quirks, exotic expressions) that kills deterministic transpilers — grounding + self-validation is the first tool shape that absorbs the variability. This is the answer to "why AI?".

## Open questions

- [ ] SigNoz Cloud vs self-hosted for the demo? (Self-hosted assumed — free, and the track examples lean self-hosted. MCP server access already exists in this environment; confirm which instance it points at.)
- [ ] Team size — solo or teammates? (Plan assumes solo; with teammates, parallelize frontend from day 2.)
- [ ] Submission form not yet published ("coming soon") — check hackathon page/Slack daily for requirements.
