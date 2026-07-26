# REQUIREMENTS v1 — DashPort

> Phase 1 (Requirements) artifact. The testable contract. Strategy in [PLAN.md](PLAN.md), build detail in [SPEC.md](SPEC.md), technical design in [DESIGN.md](DESIGN.md).
> Date: 2026-07-21.

## Problem statement

Teams cannot leave Grafana for SigNoz because SigNoz's own migration docs automate the data pipeline but tell users to **recreate dashboards by hand** ("Grafana dashboards need to be recreated in SigNoz due to differences in the dashboard JSON schemas"). No automated converter exists. We build an agent that automates that recreation, grounded against the user's live SigNoz instance and validated before anything is written.

## Actors

- **Migrator** (primary user): an engineer holding a Grafana dashboard JSON + a SigNoz instance, wanting the dashboard reproduced in SigNoz.
- **SigNoz instance**: the live backend (API key auth) that supplies metric/field metadata and receives the created dashboard.
- **The agent**: converts panels; runs autonomously per panel with tool access.

## Functional requirements (MoSCoW)

### MUST (the winning submission is exactly these)

- **F1 Connect.** Enter SigNoz base URL + API key; verify by listing dashboards. Persist locally.
- **F2 Import.** Paste/upload Grafana dashboard JSON, or select a bundled sample. Parse and show a panel inventory (count by type, each panel's title + raw PromQL).
- **F3 Convert (dry run).** For each panel, produce a SigNoz builder query without writing anything to SigNoz. Stream per-panel progress.
- **F4 Ground.** Resolve each metric/label name in the query against the live instance's real metric names; when they differ, pick the best match and record the rename with a reason.
- **F5 Validate.** Execute each generated builder query against SigNoz over a recent window; classify each panel: `validated`, `validated_with_renames`, `needs_review`, or `unsupported`. Never silently drop a panel.
- **F6 Review.** Per panel show: raw PromQL, generated builder query (readable summary), a live preview chart of the query result, status badge, and the agent's notes. Show a roll-up summary.
- **F7 Apply.** On explicit user action, create the dashboard in SigNoz via API; return a direct link. `unsupported` panels are still created with their original PromQL preserved in the panel description.
- **F8 Deterministic core.** Mechanical PromQL constructs (see DESIGN mapping table) convert via typed code with unit tests, not the LLM.
- **F9 Self-observability.** The backend emits its own traces, metrics, and structured logs (OTLP → the same SigNoz), covering every migration and every LLM/query/validate step.
- **F10 Ops dashboard + alerts.** A SigNoz dashboard built from F9 data, plus ≥1 alert rule that can visibly fire in the demo.

### SHOULD

- **F11** Downloadable migration report (markdown): per-panel status, queries, renames, limitations.
- **F12** Bundled curated demo dashboard exercising every Query Builder construct (search/agg/groupBy/having/orderBy+limit).

### COULD (stretch — only if on schedule by day 5; see SPEC)

- **F13 Alert migration.** Prometheus/Grafana alert rules YAML → SigNoz alert rules via the same pipeline.
- **F14** Step 0: search the official SigNoz dashboard-templates repo for a match before converting.

### WON'T (v1 — explicit non-goals)

LogQL/Loki panels · Grafana template variables (fixed-value substitution only) · exotic panel types (heatmap, node graph, geomap → `unsupported`) · recording rules · Datadog/New Relic sources (README roadmap only) · authentication/multi-user · any deployment beyond localhost · editing/round-tripping an already-migrated dashboard.

## Non-functional requirements

- **N1 Trust.** Nothing is written to the user's SigNoz until F7 is explicitly triggered. Dry-run is read-only.
- **N2 Transparency.** Every non-identity transformation (rename, fallback, unsupported) is surfaced with a human-readable reason.
- **N3 Determinism where possible.** Identical input + instance ⇒ identical deterministic-path output. LLM only on the long tail.
- **N4 Bounded agent.** Max 2 repair retries per panel; hard cap on tool calls per panel; per-migration token/cost budget enforced and recorded.
- **N5 Cold-start demo.** `docker compose up` (if needed) + backend + frontend runs the full flow against a fresh instance.
- **N6 Resilience.** One malformed/failed panel never aborts the whole migration; it becomes `needs_review`/`unsupported`.
- **N7 Secrets.** API key stays server-side/local; never logged, never sent to the LLM, never in telemetry attributes.

## Acceptance criteria (demo-gating, from SPEC Definition of Done)

- [ ] A1 Connect to the live SigNoz, list existing dashboards.
- [ ] A2 Import the curated demo dashboard; inventory matches its panels.
- [ ] A3 Dry-run converts all panels; ≥90% reach `validated`/`validated_with_renames`.
- [ ] A4 ≥1 panel shows a visible metric rename with reason; ≥1 `needs_review` handled gracefully (no crash).
- [ ] A5 Apply creates the dashboard; opening it in SigNoz shows the same panel shapes as the Grafana original.
- [ ] A6 Ops dashboard shows the trace + token cost of the migration just performed.
- [ ] A7 One alert rule visibly fires (threshold set low for the demo).
- [ ] A8 README maps each judging criterion + each Query Builder card to where it's satisfied.

## Traceability

Each acceptance item maps to functional reqs: A1→F1, A2→F2, A3→F3/F4/F5/F8, A4→F4/F5, A5→F7, A6→F9, A7→F10, A8→F11/F12. Every MUST has at least one acceptance check.
