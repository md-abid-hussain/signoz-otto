# HANDOFF — read this first (new session start point)

Project **Otto** — a self-hosted agentic copilot for SigNoz (Grafana→SigNoz dashboard migration + SLO copilot + MCP-backed assistant, all approval-gated). Hackathon: Agents of SigNoz, Track 02, deadline **2026-07-26**.

## Read in this order
1. `v2/PRODUCT.md` — what it is, 4 surfaces, Priya story, v1 scope + validation status.
2. `v2/DESIGN.md` — architecture, playbook engine, components, findings→design traceability.
3. `v2/TECH.md` — stack, packages, project layout, build order (§9).
4. `v2/RUNBOOK.md` — the exact migration procedure (executed manually, run 2).
5. `v2/FLOW-NOTES.md` — **the evidence base**: F1–F15, S1–S9 friction findings that drive the design. This is the agent-loop spec.
6. `backend/` — v1 code to reuse: `src/mapper/promql.ts`, `src/types.ts`, `src/signoz/serialize.ts`, `test/` (16 vitest passing).

## Accepted decisions (don't relitigate)
- Engine: **LangGraph.js** embedded (not LangGraph Server, not Vercel), `interruptBefore` = HITL gate.
- LLM: **OpenAI `gpt-5.6-terra`** via `@langchain/openai` (provider-swappable through LangChain models).
- SigNoz access: **signoz-mcp over HTTP** (`/mcp`, :8000) via `@langchain/mcp-adapters`, **`SIGNOZ-API-KEY` header required**.
- Single **admin/write key**, every write **confirmation-gated**. No DB in v1 (MemorySaver + JSON).
- API: tRPC (procedures) + one plain SSE endpoint (progress). Frontend: Vite+React+shadcn+TanStack, multi-surface shell.

## Current running environment (as of 2026-07-25)
- **SigNoz** UI/API at `http://localhost:8080` (started via foundry CLI at `C:\Users\abid1\Desktop\signoz-setup`).
- **SigNoz MCP** at `http://localhost:8000/mcp` (HTTP; needs `SIGNOZ-API-KEY` header — 401 without).
- **OTel demo** at `C:\Users\abid1\Desktop\opentelemetry-demo`, proxy on `:8081` (Grafana `/grafana`, Jaeger `/jaeger/ui`), Prometheus `:9090`. `.env` has `ENVOY_PORT=8081`. Demo collector **dual-exports** to SigNoz via `src/otel-collector/otelcol-config-extras.yml` (otel-collector joined to `signoz-network`, endpoint `signoz-ingester-1:4317`, `batch/split` processor added). ⚠️ the `docker network connect` doesn't survive container re-creation — re-run if the collector is recreated.
- **API key:** an admin/write SigNoz key exists (generated in SigNoz Settings → API Keys). **Not stored in repo** — supply via `SIGNOZ_API_KEY` env in the new session. (The dev key used in chat should be rotated.)
- MCP connector may also be attached to the assistant directly (the `mcp__signoz__*` tools); if so, use it, else call `:8000/mcp` with the header.

## Artifacts already created in SigNoz (reference / demo)
- Migrated dashboard: `019f9802-8df2-728d-8beb-5a818ea9023f` "Spanmetrics Demo — Full Migration" (7 panels).
- SLO dashboard: `019f9810-96b6-7cca-b4cf-b3c478c7ffc2` "Checkout SLO — PlaceOrder" (4 panels).
- Alert: `019f98e8-c52d-723d-89b5-61c44726e0ce` → Slack channel `sigboz-alert`.

## Build progress (2026-07-25, this session)
Built in `backend/` (kept single workspace for speed; shared/ extraction deferred):
- ✅ `src/ingest/grafana.ts` — Grafana JSON → PanelSpec[] + deps (metrics/labels) + variables + structural panels. Tested (`test/grafana.test.ts`).
- ✅ `src/signoz/mcp.ts` — MCP client over **HTTP** via `@langchain/mcp-adapters` `MultiServerMCPClient` (`url` + `SIGNOZ-API-KEY` header). **Live-verified**: 41 tools load, read/write partitioned, `.call()` unwraps the MCP `[{type:'text',text}]` content shape. Smoke: `src/scripts/mcp-smoke.ts`.
- ✅ `src/readiness/index.ts` — resolves deps against live instance (matched/renamed/missing) via the normalize heuristic. **Live-verified** on the sample: 4 renamed, 0 missing, all panels `validated_with_renames` (matches run 2). CLI: `src/scripts/readiness-cli.ts`. Tested (`test/readiness.test.ts`).
- Reused from v1: `src/mapper/promql.ts`, `src/signoz/serialize.ts`, `src/types.ts` (extended with Readiness types). **27 vitest passing.**
- Deps installed: `@langchain/{core,langgraph,openai,mcp-adapters}`, `zod`. Run TS directly with `node --experimental-strip-types` (Node 24).
- Run scripts need env: `SIGNOZ_MCP_URL=http://localhost:8000/mcp` + `SIGNOZ_API_KEY=<key>`.

## Next action (resume here)
Build **translate + validate** (`src/engine/` or `src/migration/`): for each panel → `mapPromql` → apply readiness metric-renames + label Prom→OTel rename (`service_name`→`service.name`) + resolve **fieldContext per key via `get_field_keys`** (F4) → build v5 `execute_builder_query` payload → validate live (200 + non-null aggregations = PASS). Then assemble widgets (extend serializer to emit `fieldContext` + formula scaffolding) → `create_dashboard`. Then wrap in a LangGraph `StateGraph` with `interruptBefore:["apply"]` + the agent nodes (needs `OPENAI_API_KEY`). Then tRPC + SSE + React shell. Order: TECH §9 steps 3→8.

## Open decision (unresolved)
Surface/screen renames proposed but **not applied**: Ask&Act→**Assistant**, Runs→**History**, "Run" screen→**Progress**, Receipt→**Result** (keep code type `Receipt`). Confirm words, then find-replace across v2 docs before/while building.
