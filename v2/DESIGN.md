# DESIGN — Otto (self-hosted agentic copilot for SigNoz)

> **SDLC stage:** Design. This document designs the requirements already agreed in [PRODUCT.md](PRODUCT.md); it introduces **no new scope**. It is grounded in the verified findings from two manual migration runs + one SLO run — see [FLOW-NOTES.md](FLOW-NOTES.md) (F1–F15, S1–S9) and the procedure in [RUNBOOK.md](RUNBOOK.md). Concrete stack/packages in [TECH.md](TECH.md).
> Date: 2026-07-25.

---

## 1. Scope & traceability

- **Requirements source:** PRODUCT.md §2 (four surfaces), §cross-cutting properties, §boundaries. Not restated here.
- **Design principle:** every non-obvious decision below traces to (a) a PRODUCT.md requirement or (b) a manual-run finding. See the traceability table in §11.
- **Non-goals (unchanged from PRODUCT.md):** no pipeline migration; no unattended writes; PromQL/metrics dashboards only in v1; LogQL, template-variable expansion, Datadog/NR sources are roadmap.

### 1.1 Build scope for the hackathon (honest phasing, not new requirements)

| Surface | Design status | Build target (deadline 2026-07-26) |
|---|---|---|
| Readiness & audit | Full design | **Built** — it is the shared `analyze` stage; proven manually |
| Migration (deep) | Full design | **Built** end-to-end — proven twice manually |
| SLO copilot | Full design | **Working slice** — one operation happy-path; proven manually |
| Ask & Act | Full design | **Minimal** — surface stubbed; engine supports it, UI deferred |
| Self-observability | Full design | **Built** — required for Track 02 |

---

## 2. Architecture overview

### 2.1 Deployment topology (self-hosted, single network)

```
                 user's network / host
┌──────────────────────────────────────────────────────────┐
│  Otto (docker compose)                                  │
│  ┌──────────────────────────┐     ┌─────────────────────┐  │
│  │ app container            │HTTP │ signoz-mcp sidecar  │  │
│  │  backend + built frontend│────▶│ TRANSPORT_MODE=http │  │
│  │  (SSE to browser)        │/mcp │ :8000               │  │
│  └───────────┬──────────────┘     └──────────┬──────────┘  │
└──────────────┼───────────────────────────────┼────────────┘
      OTLP (self-telem.) │  GRAFANA (optional)  │ SIGNOZ_URL + SIGNOZ-API-KEY header
              ▼          ▼                       ▼
     ┌─────────────────┐  ┌──────────────┐  (mcp → user's SigNoz)
     │ user's SigNoz   │  │ user's Grafana│
     └───────┬─────────┘  └──────────────┘
   alert fires → user's own channel (Slack `sigboz-alert`, etc.)
```

**Two distinct paths (do not conflate):**
1. **MCP ↔ SigNoz** — how the backend *reads and writes* SigNoz. The backend calls the **signoz-mcp sidecar over HTTP** (`/mcp`, :8000) with a `SIGNOZ-API-KEY` header (required — verified 401 without); the sidecar talks to the user's SigNoz. Request→response. The only control path.
2. **Alert delivery** — when a created alert *fires*, SigNoz pushes to the user's **own notification channel** (Slack in the manual run). Separate from MCP; nothing in Otto needs to receive it in v1. *(Roadmap only: alerts could webhook back to Otto for rolling-budget tracking — S8.)*

**Packaging note:** deployable is a **small compose stack** — app container (backend + built frontend) + `signoz/signoz-mcp-server` sidecar in HTTP mode. If the user's SigNoz already exposes an MCP endpoint, point `SIGNOZ_MCP_URL` at it and drop the sidecar. (HTTP chosen over stdio: matches the running setup, no binary packaging — TECH §1.)

**Rationale (PRODUCT.md privacy + FLOW-NOTES):** everything runs *inside* the user's network, so it reaches SigNoz/Grafana the same way a person does; telemetry never egresses. Only LLM prompts leave, carrying metadata only (§9). Shipping the `signoz-mcp` sidecar removes the "user must self-host MCP" tax; the user only supplies SigNoz URL + API key.

### 2.2 Backend: modular monolith with a playbook engine

Not microservices — one dev, one process, ~1.5 days, no independent scaling need. Modularity comes from the **playbook interface**, which gives the "add a workflow without touching the core" property at zero distributed-systems cost (a module can later extract to a service if ever needed).

```
backend/src/
  api/            tRPC routers + SSE stream endpoints
  engine/         playbook orchestrator (analyze→propose→approve→apply→verify)
  playbooks/
    migration/    MigrationPlaybook
    slo/          SloPlaybook
  ingest/         grafana parser (JSON upload + Grafana API pull)
  mapper/         deterministic PromQL AST → BuilderQuery   (from v1)
  agent/          LangGraph graph + nodes, prompts, tools    (TECH §4.5)
  signoz/         SigNoz access = MCP adapter (MultiServerMCPClient) + serializers (from v1)
  readiness/      shared analyze engine (grounding, gap classification)
  verify/         execute + classify + score
  otel/           self-instrumentation
  types.ts        shared domain types (from v1, extended)
```

---

## 3. The engine: playbook lifecycle

Every workflow is a `Playbook` over the same five-stage lifecycle. This is the single most important abstraction; it is exactly the shape both manual runs followed (RUNBOOK phases 0–6).

```ts
interface Playbook<TAnalysis, TProposal, TReceipt> {
  id: string;                                   // "migration" | "slo"
  analyze(ctx: RunContext): Promise<TAnalysis>; // read-only readiness
  propose(a: TAnalysis, ctx): Promise<TProposal>; // dry-run plan + evidence
  apply(p: TProposal, approvals: ApprovalSet, ctx): Promise<Applied>; // gated writes
  verify(applied: Applied, ctx): Promise<TReceipt>; // execute + score
}
```

- **This lifecycle is realized as a LangGraph `StateGraph`** (TECH §1, §4.5): nodes = stages, `interruptBefore: ["apply"]` = the approval gate. The `Playbook` interface here is the conceptual contract; the graph is its implementation. `ApprovalSet` is what the user supplies on resume.
- **analyze** and **propose** are strictly read-only (PRODUCT.md N1 trust). No SigNoz write happens before **apply**, which the graph reaches only after the user resumes with approval.
- The engine owns: run lifecycle, the OTel root span per run (§8), budget enforcement (§7), and streaming progress events to the UI over SSE.
- Adding a future playbook (deploy-guardian, log-pipeline) = implementing this interface; the engine, UI shell, MCP layer, and scoring are reused.

### 3.1 Run context

```ts
interface RunContext {
  signoz: SigNozClient;      // MCP-backed
  grafana?: GrafanaClient;   // optional live connect
  agent: AgentRuntime;
  clock: () => number;       // wall-clock ms — never estimated (F3)
  emit: (e: ProgressEvent) => void; // → SSE → UI panel cards
  budget: BudgetGuard;       // token/cost/tool-call caps (N4)
  runSpan: Span;             // OTel
}
```

---

## 4. Component design

### 4.1 Grafana ingest (`ingest/`)
- **Two modes** (PRODUCT.md §ingest): file upload (browser reaches Grafana even if backend can't) and live pull (`GET /api/search` → `GET /api/dashboards/uid/{uid}`).
- **Ingest from the API/export, never from repo/IaC files** — F8: live dashboards drift from their source (14 vs 12 targets observed).
- Output: `PanelSpec[]` + template variables + dashboard metadata. Text-panel content is captured into the target dashboard description, **never dropped unread** (structural-panel finding).

### 4.2 Deterministic mapper (`mapper/`) — reused from v1
- Pure PromQL structural decomposition → `BuilderQuery` (v1 `mapper/promql.ts`, unit-tested). Handles the golden table: selectors, matchers, rate/increase, sum/avg/min/max by, histogram_quantile, topk/bottomk, comparison→having, scalar arithmetic.
- **Runs first**; only unmapped nodes escalate to the agent. Most panels are mechanical (both runs confirmed).
- **Revision from manual runs:** histogram-percentile path must emit the traces-signal fallback, not a `.bucket` `spaceAggregation:p95` (F5 — that returns 500 in the tested build). Quantile ceiling p50/p75/p90/p95/p99; p999 → drop-with-note (F11).

### 4.3 SigNoz access (`signoz/`)
- **Path = MCP adapter over HTTP** to the signoz-mcp sidecar (`SIGNOZ_MCP_URL` = `…:8000/mcp`, `SIGNOZ-API-KEY` header) — agent-native; inherits SigNoz's own tool schema; fewer bespoke-API bugs. Tools used (verified working): `list_services`, `list_metrics`, `get_field_keys`, `get_field_values`, `execute_builder_query`, `create_dashboard`, `create_alert`, `list_notification_channels`, `create_notification_channel`, `aggregate_traces`, `get_dashboard`, `delete_dashboard`.
- **Serializers (from v1, `signoz/serialize.ts`):** the neutral `BuilderQuery` renders two ways — query-API shape (validate) and widget shape (create). Manual runs confirmed both; extend serializer to cover context differences (F12: span `name` is `type:"tag"` in widgets, `fieldContext:"span"` in query API) and formula scaffolding (F9).
- Auth: `SIGNOZ-API-KEY` header (verified 401 without).

### 4.4 Readiness engine (`readiness/`) — the shared analyze stage
The auditor-inside. For each referenced metric/label:
1. exact-name lookup, then rename-heuristic candidates (underscores→dots, strip `_total`, strip embedded unit token) — F-rename pattern.
2. **`get_field_keys(metricName)` to fetch label keys *with field contexts* — MANDATORY.** This prevents F4, the silent killer: grouping on a context-ambiguous key returns HTTP 200 + rows scanned + `aggregations: null`, no error. Every groupBy/filter key the mapper emits must carry an explicit `fieldContext`.
3. value-level check for filtered enums (F13: `STATUS_CODE_ERROR` verified verbatim).
4. multi-candidate resolution (F7/F14): prefer same-origin OTLP metric; record the choice + reason.
Output: the ✅ matched / 🔄 renamed / ❌ missing report (PRODUCT.md Priya Step 1), with a predicted per-panel verdict.

### 4.5 Agent runtime (`agent/`) — LangGraph
- **LangGraph.js `StateGraph`** (see TECH §1, §4.5). Nodes = lifecycle stages; `interruptBefore: ["apply"]` + `MemorySaver` checkpointer implement HITL natively (pause → persist → human approve/edit → resume). Model = `ChatOpenAI(gpt-5.6-terra)` via LangChain (provider-swappable); tools from `MultiServerMCPClient`.
- LLM nodes (`translate`, `repair`) are invoked **only** for what deterministic code can't: semantic metric matching, exotic-construct translation, and repair — and are bound **read tools only**.
- **Knowledge (two mechanisms):** (1) *dynamic* — the agent may call `signoz_search_docs`/`signoz_fetch_doc` (part of the MCP toolset) to look up correct SigNoz syntax on demand; (2) *static* — the SigNoz agent-skills (generating-queries, creating-dashboards, creating-alerts, writing-clickhouse-queries) are baked into the agent's system prompt as grounding. This is what cuts translation/schema failures.
- **Input to LLM = metadata only** (metric names, label keys/contexts, query shapes, candidate shortlists, aggregate stats). Never raw log bodies, span payloads, data values, or the API key (§9).
- Bounded (N4): ≤2 repair attempts per panel, per-panel tool-call cap, per-run token/cost budget; every LLM call and tool call is a child span (§8).

### 4.6 Verification engine (`verify/`) — three stages (F10)
1. **query-time:** execute each generated query (`requestType: time_series`, real clock window). PASS = 200 **and** non-null aggregations **and** ≥1 series **and** plausible magnitude. **200-with-null = FAIL** (F4, F2).
2. **create-time:** the widget/dashboard persists without API rejection.
3. **render-time:** surfaced in the review UI for the human eyeball (esp. table panels, F10).
- **Repair ladder (F6):** 400 → fix shape, retry; empty → recheck grounding/contexts; 500 → don't retry same shape, switch strategy (different signal/aggregation, F5); exhaust → `needs_review`, best attempt preserved, nothing silently dropped.
- **Fidelity check (optional, demo-grade):** same query to Prometheus, compare membership/ranking/magnitude; tolerance ~0.001% on formulas (F15). Not a correctness gate (target instance may have no Prometheus) — it's evidence.
- **Scoring:** per-run receipt = counts of validated / renamed / needs_review / unsupported, tokens, cost, duration (PRODUCT.md Priya Step 4; "evals absorbed into verification").

### 4.7 API layer (`api/`)
- One `AppRouter` with per-surface sub-routers (typed end-to-end, zero hand-written client fetching):
  - `connection` — verify, instance summary (services/metrics).
  - `migration` — start-run, get-report, approve/resume, list-receipts.
  - `slo` — analyze (traffic evidence), propose, approve/apply.
  - `ask` *(v1 minimal)* — send message; MCP-backed investigation.
- **Progress streaming:** a plain Fastify **SSE** endpoint pipes `graph.stream()` for both Migrate (per-panel `ProgressEvent{panelId,stage,status,note}`) and Ask (token/step chunks). tRPC handles request/response; SSE handles the one streaming shape (avoids tRPC-subscription boilerplate).
- The frontend is a **multi-surface app shell**, not a single migration wizard (TECH §5.1): Home, Migrate, SLOs, Ask, Runs, Settings — reusing one approval-gate component across every write.

---

## 5. Workflow designs

### 5.1 Migration playbook
- **analyze:** ingest dashboard(s) → readiness report (§4.4).
- **propose:** per panel, deterministic map → agent gap-fill → validate (§4.6 query-time) → assemble widget (golden template = a proven created dashboard JSON). Produces `PanelResult[]` with statuses + the draft dashboard JSON. No writes.
- **apply (gated):** `create_dashboard`; `unsupported`/`needs_review` panels still created with original PromQL preserved in descriptions.
- **verify:** re-fetch (`get_dashboard`), render-stage review, score.
- **Honesty rules (proven manually):** faithful-to-intent over faithful-to-bug, disclosed (F14); every rename/drop/fallback noted on the panel; layout mirrors Grafana gridPos (24-col → 12-col).

### 5.2 SLO playbook (slice)
- **analyze:** `aggregate_traces` over the target operation — volume, error %, latency percentiles, % under candidate threshold (proven: 250 orders, 0 err, p95 2.41s, 95.6% <2.5s).
- **propose:** target just above observed with small headroom, **with the reasoning shown** (S-run). Produces: SLO definition + draft SLI/budget dashboard (formula pack, S1/S2) + draft alert (S7) + required notification channel (S6).
- **apply (gated):** create channel (user picks destination — S6 is a real decision point, privacy), `create_dashboard`, `create_alert`.
- **verify:** dashboard renders; alert rule exists and evaluates.
- **Ownership split (S8, PRODUCT.md):** SigNoz holds the *artifacts* (dashboard, alert); the *SLO-as-object* (definition, rolling-30-day budget accounting, burn state) lives in the Otto platform, because SigNoz has no SLO primitive and a plain panel can't honestly show a rolling-window budget.

---

## 6. Data model (types.ts, extended from v1)

Reused unchanged: `PanelSpec`, `GrafanaTarget`, `BuilderQuery`, `Formula`, `PanelStatus`, `SigNozPanelType`, `Rename`, `PanelResult`, `MapResult`.

Added for v2:
```ts
interface ReadinessItem { name: string; kind: 'metric'|'label';
  verdict: 'matched'|'renamed'|'missing'; mappedTo?: string;
  fieldContext?: string; reason?: string; panelsAffected: string[]; }
interface ReadinessReport { items: ReadinessItem[]; perPanelPrediction: Record<string,PanelStatus>; }

interface SloDefinition { service: string; operation: string;
  objective: number; latencyThresholdNs?: number; windowDays: number;
  evidence: { samples:number; errors:number; p95Ns:number; pctGood:number }; }

interface Receipt { runId: string; playbook: string;
  counts: Record<PanelStatus, number>; tokens: number; costUsd: number;
  durationMs: number; artifacts: { dashboardId?: string; alertId?: string }[]; }

interface ApprovalSet { approvedPanelIds?: string[]; approvedSlo?: boolean;
  channel?: { type:string; destination:string }; }
```

---

## 7. Cross-cutting concerns

- **HITL (N1):** the LangGraph graph `interruptBefore` the `apply` node — it cannot proceed to any write without the user resuming with approval; UI renders the paused plan, destructive ops (delete) separately confirmed. Single admin/write key (user decision): the confirm-gate is the control, no read-only-key juggling. No auto-apply mode exists.
- **Limits (N4, revised — no budget guard):** no token/cost budgeting. Bounded work only — ≤2 agent repair attempts per panel, a per-panel tool-call cap, a per-run cap on agent-handled panels, and a run timeout; on breach, remaining panels → `needs_review`. Token usage is *recorded* in the run Receipt (§4.6) for visibility, not enforced.
- **Secrets (N7):** API key server-side only; never logged, never in LLM prompts, never in telemetry attributes.
- **Resilience (N6):** one failed panel → `needs_review`/`unsupported`, never aborts the run.

---

## 8. Self-observability (Track 02 evidence)

The platform instruments itself with OTel → the same SigNoz it manages.
- **Traces:** root span `otto.run{playbook}` → `panel.migrate{title,status,retries}` → `llm.call{model,in_tok,out_tok,cost_usd}`, `signoz.tool{name}`, `validate`.
- **Metrics:** `otto.panels{status}` counter, `otto.llm.tokens`/`cost_usd` counters, `otto.run.duration` histogram.
- **Logs:** structured (pino), trace-correlated, fields `run_id`, `panel_id`, `retry_count`, `status`.
- **Ops dashboard** (built by Otto in SigNoz, exercising the log-native Query Builder features): runs over time, cost per run, panels by status, retries `body.retry_count > 2`, top-N slowest panels.
- Demo payoff: after migrating, flip to the Otto Ops dashboard and show the trace + cost of the run just watched.

---

## 9. Privacy boundary (design detail)

The only data leaving the network is the LLM prompt. Design guarantees:
- Agent tools return metadata to the model: metric names, label keys + contexts, query shapes, candidate name shortlists, aggregate statistics (counts, percentiles).
- **Never sent:** raw log bodies, span attribute *values*, individual data points, the SigNoz API key, Grafana tokens.
- BYO LLM key; local-model swap is a roadmap line (zero-egress deployments).

---

## 10. Technology stack (decisions already taken; restated for completeness)

Full package-level detail in [TECH.md](TECH.md); summary:

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript end-to-end | one language; v1 code already TS |
| Backend | Node + Fastify | long-running agent jobs need a persistent process (not serverless) |
| API | tRPC v11 + zod, SSE subscriptions for streams | typed client with ~zero glue; zod shared with mapper |
| Frontend | Vite SPA + React + shadcn/ui + TanStack Query/Router | known stack; no SSR framework needed |
| Agent framework | **LangGraph.js** + `@langchain/openai` (`ChatOpenAI`, `gpt-5.6-terra`) | native HITL interrupts; provider-swappable (TECH §1) |
| SigNoz access | `signoz-mcp` sidecar over **HTTP** (`/mcp`, `SIGNOZ-API-KEY` header) via `@langchain/mcp-adapters` | agent-native; matches running setup; no binary packaging |
| Telemetry | `@opentelemetry/*` (auto + manual spans) → same SigNoz | §8 |
| Packaging | small compose stack: app container (backend + built frontend) + signoz-mcp sidecar | lifts to one EC2 box unchanged, after the demo video |

---

## 11. Traceability: findings → design decisions

| Finding | Design response |
|---|---|
| F3 no-guess clock | `RunContext.clock`; all queries use real wall-clock windows |
| F4 silent null on ambiguous field | Readiness fetches field-keys+contexts (mandatory); verify treats 200+null as FAIL; serializer always emits `fieldContext` |
| F5 histogram-percentile 500 | Mapper emits traces-signal percentile fallback; repair ladder switches strategy on 500 |
| F6 400 vs 500 repair | Two-branch repair ladder in verify |
| F1 order-by-name 400 | Serializer omits `order`; `limit` implies value-desc |
| F2 scalar returns null | Validate with `time_series` |
| F7/F14 multi-candidate + intent-vs-bug | Agent records choice + reason; disclosed on panel |
| F8 IaC drift | Ingest from Grafana API/export, not repo files |
| F9 formula explosion | Formulas get explicit `limit` + full scaffolding |
| F10 table render risk | Three-stage verification (query/create/render) |
| F11 no p999 | Drop-with-note quantile rule |
| F12 context differs API vs widget | Dual serializer with context mapping table |
| F13 enum values verbatim | Value-level readiness check for filtered enums |
| F15 fidelity tolerance | Fidelity = ranking+magnitude evidence, not exact-equality gate |
| S1/S2 SLI formula + value panel | SLO formula-pack template |
| S3 duration filter inline | seconds→ns conversion in SLO propose |
| S6 alert needs channel | SLO apply provisions/selects a channel (user picks destination) |
| S7 alert mirrors panel query | Alert serializer reuses SLI query pack |
| S8 rolling budget not native | SLO-object + budget accounting owned by Otto platform |
| S9 API silently changed evalWindow | Verify stage reads back the created object and diffs vs intent — never trust the request echo |

---

## 12. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Time (deadline 07-26) | high | Ruthless phasing (§1.1): migration deep + SLO slice + self-obs; Ask&Act minimal; UI thin over a proven engine |
| Build-specific SigNoz quirks (500s, schema drift) | med | Engine already designed around them (F5/F6); MCP validation-notice self-correction helps |
| Demo data sparse/synthetic | med | OTel demo load-gen running; start stack early for SLO history; SLO caveat stated honestly |
| Rolling-window burn-rate depth | med | v1 = threshold alert (proven, S7); multi-window burn is roadmap |
| Table/exotic render fidelity | low | Render-stage human gate; fallback to split panels |

---

## 13. What is reused vs new

- **Reused from v1 (unchanged or lightly revised):** `types.ts`, `mapper/promql.ts` (+ traces-fallback revision), `signoz/serialize.ts` (+ context/formula extensions), the vitest suite.
- **New in v2:** engine + playbook interface, readiness engine, agent runtime, MCP client layer, verify/score, SLO playbook, self-instrumentation, tRPC API, React UI.
- **Dropped:** the v1 hand-rolled REST dashboard-create path (superseded by MCP `create_dashboard`).
