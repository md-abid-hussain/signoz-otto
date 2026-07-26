# TECH — Frameworks, packages, and engineering principles

> **SDLC stage:** Design (technical). Companion to [DESIGN.md](DESIGN.md) (architecture) — this document fixes the concrete stack, packages, project layout, and coding principles. No new requirements. Fast-moving choices (LLM SDK, MCP SDK) verified against current docs on 2026-07-25.
> Verified sources: [LangGraph.js HITL guide](https://langgraphjs.guide/human-in-the-loop/), [LangChain MCP adapters](https://docs.langchain.com/oss/javascript/langchain/mcp) (`@langchain/mcp-adapters` 1.1.3), [LangGraph.js docs](https://langgraphjs.guide/). (Also evaluated + rejected: OpenAI Agents SDK JS, raw `@modelcontextprotocol/sdk` — see §1.3.)

---

## 1. Agent framework & LLM provider — decision

**User decisions (2026-07-25):** use OpenAI (credit on hand), model `gpt-5.6-terra`; **not Vercel** (LangGraph preferred); SigNoz access via the **SigNoz MCP server over HTTP** (`/mcp` on port 8000, `TRANSPORT_MODE=http`), client sends **`SIGNOZ-API-KEY` header** (verified required — 401 without); single **admin/write API key** with **every write action confirmation-gated** (software HITL is the control). Verified: [SigNoz MCP self-hosted](https://signoz.io/docs/ai/signoz-mcp-server/?plans=self-hosted).

### 1.1 What we use
- **LangGraph.js** (`@langchain/langgraph`) as the agent framework. Each workflow is a `StateGraph` whose nodes are the lifecycle stages (analyze → translate → validate → **[interrupt]** → apply → verify). HITL is native: `interruptBefore: ["apply"]` + a checkpointer pauses the graph, persists full state, waits for the user's approval (which can edit the plan via `graph.updateState()`), then resumes. This *is* propose→approve→apply — not bolted on. Verified: [LangGraph.js HITL guide](https://langgraphjs.guide/human-in-the-loop/).
- **`@langchain/openai`** `ChatOpenAI`, model = `LLM_MODEL` (`gpt-5.6-terra`). Provider swap = `ChatAnthropic` from `@langchain/anthropic`, one line — LangChain's model abstraction *is* the provider seam (no custom adapter needed).
- **`@langchain/mcp-adapters`** `MultiServerMCPClient` — connects to the bundled `signoz-mcp` and returns LangChain-compatible tool objects. Single SigNoz access point: deterministic stages `.invoke()` tools directly (no LLM); LLM nodes get a curated read-only subset bound. [Verified](https://docs.langchain.com/oss/javascript/langchain/mcp).
- **Checkpointer:** `MemorySaver` (in-process) for the hackathon; `PostgresSaver` is a one-line swap for production. Run state = graph state, so runs survive restarts for free.

### 1.2 How HITL is enforced (mechanism, not hope)
- The graph interrupts **before** the `apply` node. Everything up to it (readiness, translation, validation) is read-only — the LLM nodes are bound only read tools, so they *cannot* write.
- On resume (user approval), the `apply` node performs writes **deterministically in code** (not via the model), using the admin/write key. Destructive ops (delete) get their own explicit confirm.
- Single write key + confirm-gate matches the manual runs exactly; no read-only key juggling (per user decision).

### 1.3 Alternatives considered
| Option | Verdict |
|---|---|
| **Vercel AI SDK** | Rejected (user preference) — and LangGraph's native interrupts model our HITL better anyway. |
| **OpenAI Agents SDK** (`@openai/agents`) | Rejected: OpenAI-centric (weakens provider swap) and weaker explicit HITL than LangGraph interrupts. |
| **Raw `openai` SDK + hand loop** | Rejected: re-implements the graph/checkpoint/interrupt machinery LangGraph provides. |
| **LangGraph.js** | **Chosen** — native HITL interrupts, provider-agnostic via LangChain models, first-class MCP tools. |

### 1.4 Honesty note on the model
`gpt-5.6-terra` is a config string; its exact context window / pricing / API surface is verified against OpenAI's live docs + a probe call at wiring time (§10), not assumed here.

---

## 2. Runtime & repo tooling

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 24.x | verified installed (v24.13) |
| Language | TypeScript 5.6+, ESM, `"strict": true`, `noUncheckedIndexedAccess` | matches v1 backend tsconfig |
| Monorepo | **npm workspaces** | user has npm 11; avoid introducing pnpm/yarn |
| Dev runner | `tsx` (backend), `vite` (frontend) | |
| Tests | `vitest` | already used by v1 mapper suite |
| Build | `tsc` (backend), `vite build` (frontend) | |
| Container | Docker compose | app container (backend serves built frontend) + `signoz/signoz-mcp-server` sidecar in HTTP mode; or point at an existing MCP endpoint |
| Lint/format | eslint + prettier (light config) | not load-bearing; keep minimal |

### 2.1 Workspace layout
```
otto/
  package.json                # workspaces: ["shared","backend","frontend"]
  Dockerfile                  # backend + built frontend (one image)
  docker-compose.yml          # app + signoz-mcp sidecar (HTTP, :8000/mcp) — or point at existing
  .env.example
  shared/                     # types + zod schemas shared FE/BE
    src/types.ts              # ← v1 types.ts moves here
  backend/
    src/
      index.ts                # fastify bootstrap + otel init (imported first)
      api/                    # tRPC routers + context
      engine/                 # playbook orchestrator + RunContext + BudgetGuard
      playbooks/{migration,slo}/
      ingest/                 # grafana parser (upload + API pull)
      mapper/                 # ← v1 mapper/promql.ts (+ traces-fallback)
      agent/                  # LangGraph graph + nodes, prompts, tool wiring
      signoz/                 # MCP adapter (MultiServerMCPClient) + serializers (← v1 serialize.ts)
      readiness/              # analyze engine
      verify/                 # execute + classify + score
      otel/                   # instrumentation.ts
    test/                     # vitest (mapper, readiness, serializers)
  frontend/
    src/
      main.tsx, router.tsx
      routes/{connect,readiness,run,review,receipts}.tsx
      components/ui/          # shadcn components
      lib/trpc.ts             # typed client
  deploy/                     # otel-collector extras, sample dashboards
  samples/                    # exported grafana dashboards for demo
```

---

## 3. Backend packages

| Package | Purpose | Pin/notes |
|---|---|---|
| `fastify` + `@fastify/cors` | HTTP server | long-running process for agent jobs |
| `@trpc/server` (v11) | typed API + **SSE subscriptions** for live run progress | v11 has built-in SSE subscription transport — no separate SSE lib |
| `zod` | validation, shared with mapper + tRPC + tools | v3.25+ (MCP/LangChain peer-dep compatible) |
| `@langchain/langgraph` | agent framework — StateGraph, checkpointing, **interrupts (HITL)** | + `MemorySaver` (dev checkpointer) |
| `@langchain/core`, `@langchain/openai` | model = `ChatOpenAI(gpt-5.6-terra)`; swap → `@langchain/anthropic` | LangChain model = provider seam |
| `@langchain/mcp-adapters` | `MultiServerMCPClient` → signoz-mcp over **HTTP** (`url` + `SIGNOZ-API-KEY` header); returns LangChain tools | single SigNoz access point (v1.1.3) |
| `@opentelemetry/sdk-node`, `/auto-instrumentations-node`, `/exporter-trace-otlp-grpc`, `/exporter-metrics-otlp-grpc`, `/api` | self-observability → same SigNoz | init before app code |
| `pino` | structured, trace-correlated logs | |
| `undici`/global `fetch` | Grafana API pull | Node 24 has global fetch |
| (none) | PromQL parsing | our hand-rolled mapper — no maintained JS PromQL parser worth adding |

**No database in v1 (deliberate).** Persistence needs are minimal: LangGraph run state → `MemorySaver` (in-process; only lost on a mid-run backend restart — acceptable for the demo); run receipts → JSON on disk; SLO-as-object rolling-budget tracking → roadmap (S8), not v1. Connection/keys → env, never a DB. **Optional stretch (keeps single-container):** SQLite via `better-sqlite3` for durable run history + SLO catalog + `SqliteSaver` checkpoints — add only if the core is done. **Production:** Postgres alongside SigNoz (which already runs its own metastore Postgres; we never touch it).

---

## 4. Component technical notes

### 4.1 SigNoz access via MCP adapter (`signoz/mcp.ts`)
- `MultiServerMCPClient` (`@langchain/mcp-adapters`) connects to signoz-mcp over **HTTP** (streamable-http): `{ signoz: { url: SIGNOZ_MCP_URL, headers: { "SIGNOZ-API-KEY": SIGNOZ_API_KEY } } }`. `SIGNOZ_MCP_URL` = `http://<host>:8000/mcp` — a sidecar we run (`signoz/signoz-mcp-server`, `TRANSPORT_MODE=http`) or the user's existing MCP endpoint. The header is **required** (verified: 401 without).
- It returns all signoz-mcp tools as LangChain tool objects. We partition them into a typed `SigNozTools` map: **read** (`list_metrics`, `get_field_keys`, `get_field_values`, `execute_builder_query`, `list_services`, `aggregate_traces`, `get_dashboard`) and **write** (`create_dashboard`, `create_alert`, `create_notification_channel`, `delete_dashboard`).
- The admin key lives only in the backend env and the MCP request header; never in the client bundle, prompts, or telemetry.

### 4.2 Tool gating = the HITL mechanism
- **LLM nodes** (translate, repair) are bound **read tools only** — the model physically cannot write.
- **Deterministic stages** (readiness, validate) `.invoke()` read tools directly, no LLM.
- **Writes** happen only in the `apply` node, which runs *after* the graph's `interruptBefore` approval, executed in code (not by the model), with each destructive op (delete) separately confirmed. This is how "every write is confirmation-based" is enforced structurally.

### 4.3 Deterministic core (pure, unit-tested)
- `mapper/` (v1) and `readiness/` classification and `signoz/serialize.ts` (v1) are **pure functions** — no IO, fully vitest-covered. IO lives only in `agent/`, `signoz/mcp.ts`, `ingest/`, `api/`.

### 4.4 Streaming
- Run progress → tRPC v11 SSE subscription → TanStack Query on the client animates panel cards. One event type `ProgressEvent`.

### 4.5 The playbook as a LangGraph StateGraph
```
StateGraph<RunState>:
  ingest → readiness → translate → validate ─(pass)─▶ interrupt(apply) → apply → verify → END
                          ▲            └─(fail)─▶ repair ─(≤2)─┘
  interruptBefore: ["apply"]        checkpointer: MemorySaver (dev)
```
- `RunState` holds panels, statuses, the draft artifact, receipts — checkpointed after each node.
- `translate`/`repair` are LLM nodes (`ChatOpenAI` bound to read tools). `readiness`/`validate` are plain nodes.
- The graph halts at `interrupt(apply)`; the API surfaces `RunState` to the UI; approval (optionally `updateState`) resumes into `apply`.
- Limits (N4): bounded loops only — repair-attempt cap, per-panel tool-call cap, per-run panel cap, run timeout (no token/cost budgeting; usage recorded in the Receipt). Each node wraps an OTel span.
- **Concurrency (UX/latency):** panels are independent, so `translate`+`validate` run **bounded-concurrent** (e.g. 4 at a time — cap respects LLM rate limits + budget). Deterministic panels finish in ms; only the LLM tail costs seconds. Combined with SSE per-panel streaming, a full dashboard feels live and completes in well under ~2 min. The streaming progress UI is therefore essential, not optional.

---

## 5. Frontend packages

| Package | Purpose |
|---|---|
| `react`, `react-dom`, `vite`, `@vitejs/plugin-react` | SPA base |
| `@trpc/client`, `@trpc/tanstack-react-query`, `@tanstack/react-query` | typed data layer, zero hand-written fetch |
| `@tanstack/react-router` | routing (5 routes) |
| `tailwindcss`, shadcn/ui (Radix primitives), `lucide-react` | UI kit |
| `react-hook-form`, `@hookform/resolvers`, `zod` | Connect form + SLO edit form |
| `recharts` | live preview charts in Review + SLO screens |
| `assistant-ui` *(optional, Ask&Act only)* | chat runtime with a plain (non-LangGraph-Server) React runtime; hand-rolled list is the fallback |
| `shared` (workspace) | domain types + zod schemas |

### 5.1 App structure — a multi-workflow shell (not a single wizard)

The frontend is an **app shell** hosting the four PRODUCT surfaces, with global connection state and shared components (approval gate, readiness view, preview chart, status badges). It is **not** one linear flow.

```
App shell (nav + global connection)
├─ Home            instance summary, recent runs, quick actions, link to Otto Ops dashboard
├─ Migrate  [full] Import → Readiness → Run (SSE cards) → Review (query diff + preview + approve) → Receipt
├─ SLOs     [slice] pick service/op → analyze traffic → proposed target + evidence → edit → approve → dashboard+alert
├─ Ask      [min]  chat: ask → MCP investigation → streamed answer + evidence; inline approve card on any write
├─ Runs            receipts history (scores, cost, artifacts, links)
└─ Settings        SigNoz + Grafana connection, model, budget caps
```

**Streaming:** Migrate's Run screen and Ask's responses both stream over the **same SSE mechanism** (embedded LangGraph `graph.stream()` → SSE). No LangGraph Server, no `useStream` — those are for the LangGraph-Platform hosting model we don't use.

**v1 build scope:** shell + Connect + Migrate (full) + Runs + SLO (slice) built; Ask&Act stubbed/minimal (engine supports it, UI deferred — DESIGN §1.1).

---

## 6. Engineering principles

1. **Deterministic-first, LLM for the tail.** Mechanical translation is typed code; the model handles only semantic matching, exotic constructs, and repair (findings show most panels are mechanical).
2. **Provider-agnostic LLM.** Via LangChain model abstraction (`ChatOpenAI`↔`ChatAnthropic`), model as config. OpenAI now.
3. **MCP is the only SigNoz boundary.** `MultiServerMCPClient` → curated read/write tool split; no bespoke REST except where MCP lacks a call.
4. **HITL by construction.** LangGraph `interruptBefore: ["apply"]`; LLM nodes hold read tools only; writes run post-approval in code. No auto-apply exists.
5. **Pure core, IO at edges.** Enables fast unit tests and deterministic behavior (N3).
6. **Fail-soft per unit.** One panel/alert failing → `needs_review`/`unsupported`, never aborts the run (N6).
7. **Verify, don't trust.** Three-stage verification (query/create/render); always read back created objects and diff against intent (S9: API silently changed evalWindow).
8. **Dogfood observability.** Every stage traced/metered/logged into the same SigNoz — the product observing itself is also the Track 02 evidence.
9. **Typed end-to-end.** zod schemas shared FE↔BE via tRPC; no untyped fetch.
10. **Secrets server-side only.** API keys/tokens never in prompts, logs, telemetry, or the client bundle (N7, §privacy).

---

## 7. Config & environment

`.env` (never committed; `.env.example` documents keys):
```
# SigNoz target
SIGNOZ_URL=http://host.docker.internal:8080
SIGNOZ_API_KEY=...                    # server-side only; also sent as SIGNOZ-API-KEY header to MCP
# MCP (HTTP transport)
SIGNOZ_MCP_URL=http://host.docker.internal:8000/mcp   # signoz-mcp sidecar or existing endpoint
# LLM (LangChain ChatOpenAI; swap provider → LLM_PROVIDER=anthropic)
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.6-terra
OPENAI_API_KEY=...
# Limits (N4 — bounded work, NOT token/cost budgeting; usage is recorded in the Receipt only)
PANEL_REPAIR_ATTEMPTS=2
PANEL_TOOLCALL_CAP=8
RUN_PANEL_CAP=50          # max panels handed to the LLM per run
RUN_TIMEOUT_MS=600000
# Self-telemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4317
OTEL_SERVICE_NAME=otto
# Optional Grafana live-connect
GRAFANA_URL=
GRAFANA_TOKEN=
```

---

## 8. Testing strategy

- **Unit (vitest, fast, no IO):** mapper golden table (v1 suite, extended), readiness rename-heuristic + field-context classification, serializers (query-API vs widget shapes, incl. F12 contexts, F9 formula scaffolding).
- **Contract fixtures:** the manually-created dashboards/alert JSON from FLOW-NOTES become golden fixtures the serializers must reproduce.
- **Integration (optional, gated by env):** a smoke test that runs analyze→propose→validate against the live demo SigNoz via MCP — skipped in CI when `SIGNOZ_URL` absent.
- No E2E browser tests under the deadline; manual demo-script walkthrough substitutes.

---

## 9. Build order (implementation sequence)

Matches DESIGN §1.1 phasing:
1. `shared/types` + move v1 mapper/serializers in; green the vitest suite.
2. `signoz/mcp.ts` MCP adapter (`MultiServerMCPClient`) + `readiness/` — reproduce the manual readiness output.
3. `engine/` LangGraph `StateGraph` + `MigrationPlaybook` nodes (analyze/translate/validate/verify), CLI-drivable, no UI — reproduce run 2 end-to-end.
4. `agent/` LangGraph LLM nodes (`ChatOpenAI`) + gap-fill/repair tools; add `interruptBefore: ["apply"]`.
5. `frontend/` 5 screens over the tRPC API + SSE.
6. `otel/` self-instrumentation + Otto Ops dashboard.
7. `SloPlaybook` slice.
8. docker-compose packaging; README + demo video.

---

## 10. Open technical items (verify at wiring, don't assume)

- Exact `@langchain/openai` `ChatOpenAI` config for `gpt-5.6-terra` (model id string + any Responses/Chat flag) — confirm against live OpenAI docs + a probe call.
- `@langchain/mcp-adapters` `MultiServerMCPClient` HTTP config shape (per-server `url` + `headers`) for signoz-mcp `/mcp` — confirm the exact header-passing API in adapter v1.1.3.
- LangGraph.js `interruptBefore` + `MemorySaver` resume flow across a tRPC request boundary (thread id ↔ run id mapping) — confirm the resume-with-updateState API.
- tRPC v11 SSE subscription + fastify adapter wiring — confirm current adapter API.
- SigNoz `create_alert` evalWindow override behavior (S9) — read back and reconcile.
