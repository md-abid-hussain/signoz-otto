# SPEC v1 — DashPort (working name)

> Concrete build spec. Strategy/why lives in [PLAN.md](PLAN.md). Date: 2026-07-21 (5.5 days to deadline Jul 26).

**One-liner:** Paste a Grafana dashboard JSON → an agent converts it to a validated SigNoz dashboard, panel by panel, grounded against your live SigNoz instance — with the agent itself fully observable in the same SigNoz.

## User flow (the whole product in 5 steps)

1. **Connect** — enter SigNoz base URL + API key. App verifies by listing existing dashboards.
2. **Import** — paste Grafana dashboard JSON (or upload file, or pick a bundled sample). App parses and shows the panel inventory: "14 panels found: 9 timeseries, 3 stat, 1 gauge, 1 table."
3. **Convert (dry run)** — agent processes panels one by one; UI streams live per-panel status cards.
4. **Review** — per panel: original PromQL ↔ generated Builder Query (human-readable summary) ↔ live preview chart from SigNoz data ↔ status badge + agent's notes ("renamed `http_request_duration_seconds` → `http.server.request.duration`, matched by semantic convention").
5. **Apply** — one click creates the dashboard in SigNoz; success screen links directly to it.

Two-phase (dry-run → review → apply) is deliberate: nothing touches the user's SigNoz until they approve. That's the trust story.

## Architecture

```
React SPA (Vite + shadcn)
   │  REST + SSE
Node/TS backend (Fastify)
   ├─ parser: Grafana JSON → internal PanelSpec[]
   ├─ mapper: deterministic PromQL AST → BuilderQuery (unit-tested)
   ├─ agent loop: Anthropic SDK, tools below
   └─ SigNoz client: dashboards / query / fields / alerts APIs
        │
   SigNoz (self-hosted, Docker) ◄── OTLP ── OTel demo app (Astronomy Shop)
        ▲
        └── OTLP ── the backend's own telemetry (meta-layer)
```

## Agent pipeline (per panel)

```
parse (deterministic, promql-parser WASM → AST)
  → deterministic map attempt
      • full success → status: mapped
      • partial/unsupported nodes → agent translate (LLM + tools)
  → ground: resolve metric + label names against live instance
      • exact match → proceed
      • no match → agent semantic-match (list_metrics + conventions) → note the rename
  → validate: execute BuilderQuery over last 30m
      • non-empty + sane shape → status: validated
      • empty/error → agent repair (max 2 retries) → else status: needs_review
  → panel assembly: type, title, unit, thresholds, legend
```

Per-panel terminal statuses: `validated` (green) · `validated_with_renames` (green + note) · `needs_review` (amber, best-effort query + agent's explanation) · `unsupported` (gray, original PromQL preserved in panel description). **Never silently drop a panel.**

## Deterministic mapper scope (v1)

| PromQL construct | BuilderQuery mapping |
|---|---|
| `metric{label="x", label2=~"y.*"}` | metric + filters (=, REGEXP) |
| `rate(m[5m])`, `increase(m[5m])` | rate/increase aggregation |
| `sum/avg/min/max/count by (a, b) (...)` | aggregation + group by |
| `histogram_quantile(0.95, sum by (le) (rate(m_bucket[5m])))` | p95 on the histogram metric |
| `topk(n, ...)` / `bottomk(n, ...)` | order by desc/asc + limit n |
| `expr > N` (comparison on aggregate) | having |
| `expr * 100`, scalar arithmetic | query formula |
| Anything else (`label_replace`, subqueries, `offset`, vector matching…) | → agent, closest translation + `needs_review` |

## Agent tools (function-calling)

- `list_metrics(search?)` — metric names + types from the SigNoz instance
- `get_fields(metric)` — available label/attribute keys + sample values
- `run_builder_query(query, time_range)` — execute, return series count + sample datapoints
- `create_dashboard(dashboard_json)` — apply phase only
- (stretch) `create_alert_rule(rule_json)`

Small toolset, every call traced. The agent never sees raw dashboard JSON — only one parsed panel at a time with its AST.

## Backend API

- `POST /api/connections/verify` — check SigNoz URL + key
- `POST /api/migrations` — body: dashboard JSON → returns migration id, starts dry run
- `GET /api/migrations/:id/events` — SSE stream of per-panel progress
- `GET /api/migrations/:id` — full result (panel list + statuses + queries)
- `POST /api/migrations/:id/apply` — create dashboard in SigNoz, return its URL

## Frontend screens (shadcn)

1. **Connect** — form (react-hook-form + zod), test button, stored in localStorage.
2. **Import** — textarea/dropzone + sample picker; panel inventory table.
3. **Run** — grid of panel cards updating via SSE: spinner → status badge; expandable to see agent steps.
4. **Review** — per-panel detail: PromQL (highlighted) | BuilderQuery summary | preview chart (render SigNoz query result with recharts) | agent notes. Summary bar: "11 validated · 2 renamed · 1 needs review."
5. **Done** — link to dashboard in SigNoz + migration report (downloadable markdown).

## Self-instrumentation (meta-layer — never cut)

- **Traces:** root span `migration.run` → child `panel.migrate` (attrs: panel_title, status, retries) → children `llm.call` (attrs: model, input_tokens, output_tokens, cost_usd), `signoz.query`, `validate`.
- **Metrics:** `dashport.panels.migrated` (counter, attr status), `dashport.llm.tokens` (counter), `dashport.llm.cost_usd` (counter), `dashport.migration.duration` (histogram).
- **Logs:** structured JSON via pino, trace context injected, fields: `panel_id`, `retry_count`, `validation_status`.
- **Ops dashboard** (built in SigNoz, exercises log-native Query Builder features per PLAN's card-coverage table): cost per migration, panels by status (group by), retries `body.retry_count > 2` (JSON body search), logs with `EXISTS trace_id`, top-5 slowest panels (order by + limit), groups with `count() > N` (having).
- **2 alert rules:** panel failure ratio > 30% in 15m; LLM cost per hour > $2. Notification channel: webhook (or Slack if easy).

## Stretch: alert rule migration (only if on schedule by day 5)

- Input: Prometheus alerting rules YAML (`groups[].rules[]`: `expr`, `for`, `labels`, `annotations`) — also covers Grafana-provisioned alerts.
- Same pipeline: parse expr → map/ground/translate → create SigNoz alert rule via API (threshold from the comparison, eval window from `for`).
- Validation: rule's query executes non-empty; rule appears in SigNoz alerts list.
- UI: second tab on Import screen ("Alert rules"), same card flow.

## Demo environment

- Docker Compose: self-hosted SigNoz + OpenTelemetry demo app (Astronomy Shop) with collector configured to export OTLP → SigNoz.
- Source dashboards for the demo: the OTel demo's bundled Grafana dashboards (its compose ships Grafana + Prometheus, giving true side-by-side) **plus one curated dashboard** authored to contain every construct in the mapper table (= every Query Builder card).
- Backend's own OTLP also points at the same SigNoz.

## Repo layout

```
/frontend        Vite + React + shadcn
/backend         Fastify + agent + mapper + signoz client
  /src/mapper    deterministic PromQL→Builder (+ unit tests, the most-tested code)
  /src/agent     loop, tools, prompts
  /src/otel      instrumentation setup
/samples         demo Grafana dashboard JSONs + alert rules YAML
/deploy          docker-compose (signoz + otel-demo)
/docs            README assets, architecture diagram
```

## Milestones (revised for Jul 21 start)

| Day | Date | Deliverable (deliverable = demonstrable, not "worked on") |
|---|---|---|
| 1 | Jul 21 | ~~Compose up SigNoz~~ (**already running** — live instance connected via MCP, has metrics `signoz_calls_total`/histograms + traces). DONE: repo scaffolded, shared types, deterministic mapper + 16 passing tests, dual serializers, compile-target shape validated against live backend. TODO: a Grafana dashboard sample in `/samples`; ensure fresh metric data for demo window (note: instance uses 2026 epoch timestamps). |
| 2 | Jul 22 | Parser + deterministic mapper for the table above, unit tests green. CLI: sample dashboard → BuilderQueries printed + executed against SigNoz (no LLM yet). |
| 3 | Jul 23 | Agent loop: grounding, fallback translation, validate + repair. CLI end-to-end: sample dashboard → created SigNoz dashboard. |
| 4 | Jul 24 | Frontend: all 5 screens against real backend, SSE streaming. |
| 5 | Jul 25 AM | Meta-layer: OTel wiring, ops dashboard, 2 alerts. |
| 5 | Jul 25 PM | GO/NO-GO on alert migration stretch. Polish, edge cases, freeze. |
| 6 | Jul 26 | README (criteria mapping, card-coverage table, limitations, roadmap), demo video, submit. No new code. |

## Definition of done (demo checklist)

- [ ] Cold start: `docker compose up` + two `npm run dev` = working system
- [ ] Migrate the curated dashboard: ≥90% panels green, ≥1 visible rename, ≥1 needs_review handled gracefully
- [ ] Migrated dashboard opens in SigNoz next to Grafana original showing same shapes
- [ ] Ops dashboard shows the trace + cost of the migration just performed
- [ ] One alert rule visibly fires (lower threshold live in demo)
- [ ] README: architecture diagram, quickstart, judging-criteria map, honest limitations

## Out of scope (say no)

LogQL/Loki panels · Grafana template variables (fixed-value substitution only) · exotic panel types (heatmap, node graph → `unsupported` with preserved query) · recording rules · Datadog/NR sources (README roadmap only) · auth/multi-user · deployment beyond localhost.
