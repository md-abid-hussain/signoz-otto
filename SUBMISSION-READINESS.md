# Otto — Submission Readiness (Track 02: Signals & Dashboards)

_Assessment date: 2026-07-26. Legend: ✅ done & verified live · ⚠️ done, needs a double-check · ⛔ not implemented._

Otto is a self-hosted agentic copilot for SigNoz: one LangGraph engine (analyze → propose → approve → apply → verify) over the live SigNoz MCP, with a React/TanStack + React-Router frontend, full OpenTelemetry self-instrumentation, and every write behind a human approval gate.

---

## 1. What's built & verified

### Surfaces (frontend pages, each on its own route)
| Surface | Route | State | Notes |
|---|---|---|---|
| Overview | `/` | ✅ | connection status, live service map (Otto held separate as the copilot) |
| Coverage audit | `/audit` | ✅ | service × {traces,metrics,logs} matrix from live `get_field_values`; gaps + collector hint |
| Migrate | `/migrate` | ✅ | Grafana list **+ JSON upload**; **live SSE steps** (parse→readiness→translate→per-panel→assemble→apply→verify); receipt + fidelity check; approval gate |
| SLO copilot | `/slo` | ✅ | service/operation/channel **dropdowns**; **live SSE steps**; SRE-grade analysis (binding SLI, trend, alternatives, error budget); approval gate |
| AgentOtto 🕵️ | `/agent` | ✅ | deepagents chat, **full** MCP toolset, **multi-turn memory**, write-approval card |
| Run history | `/runs` | ✅ | scored receipts for every applied migration/SLO |
| Otto Ops | `/ops` | ✅ | self-observability story + builds the Ops dashboard |
| About | `/about` | ✅ | what each surface does + use cases; per-surface ⓘ info modals |

### Engine & agents
- ✅ Deterministic PromQL→Query-Builder mapper (27 vitest tests pass) + agent tail for the hard panels.
- ✅ Faithful-replica migration (title/desc/tags/section-rows/`service.name` variable) + a **replication/fidelity check**.
- ✅ Robust variable resolution — the old broken `traceId` textbox variable can no longer ship (type check + live resolve + filter sanitizer).
- ✅ SLO copilot: evidence → latency trend → SRE reasoning → proposal → dashboard + fast-burn alert. `create_alert` schema fixed and verified.
- ✅ AgentOtto: full SigNoz toolset, 12 skills loaded, conversation memory (shared checkpointer + stable thread_id), HITL write loop verified (created a real alert after approval, then cleaned up).

### Cross-cutting (Track 02 core)
- ✅ **Full OpenTelemetry self-instrumentation** to the same SigNoz it manages: backend service `otto` (traces `otto.run → panel.migrate → llm.call`, `signoz.tool` spans, HTTP), agent internals traced via a LangChain→OTel callback bridge, and a frontend RUM service `otto-web`. Both appear as services in SigNoz.
- ✅ Human-in-the-loop on every write; reads are free.
- ✅ Privacy: only metadata reaches the LLM.
- ✅ Backend + frontend typecheck clean; 27/27 backend tests pass.

---

## 2. Double-check before submitting (⚠️)

1. **Visual QA of every page.** The build is verified structurally (renders, no console errors) but has **not been eyeballed** page-by-page. Click through all 8 routes at a real viewport; confirm spacing, the amber/phosphor balance, the fixed chat bubble, the info modals, and the live-step panels look right. (I could not screenshot — the Browser pane wasn't displayed.)
2. **Live-step UX end to end in the browser.** The SSE streams are verified via curl (SLO + migrate emit all events). Confirm the **frontend** renders them incrementally (not one jump at the end) for both a dry-run and an apply.
3. **AgentOtto write path in the UI.** The approval card + resume is verified via API. Click **Approve** in the actual chat once to confirm the card → execute path works through the browser (then delete any test artifact).
4. **Migration agent variance.** The agent runs at temperature 1, so panel counts vary run-to-run (e.g. Average Duration vs Quote Service). Do a couple of runs; the deterministic panels are stable, the agent tail is not. Decide which dashboard to show in the demo.
5. **`OTTO_OTEL=1` for the demo.** Self-instrumentation only exports when the backend is started with `OTTO_OTEL=1`. Start it that way so Otto Ops has live data, and let it run a migration first so there's a trace to show.
6. **SigNoz OTLP :4318 reachable** for `otto-web` RUM (via the Vite `/otlp` proxy). Confirm `POST /otlp/v1/traces → 200`.
7. **Clean the instance for the demo** — delete stray test dashboards/alerts so the story is tidy.
8. **Ports** — backend 8010 (single instance; kill duplicates), frontend Vite 5273/5274.

---

## 3. Still to implement (⛔ / partial)

Prioritised by demo/judging value:

1. **Migration review with a live preview chart** — the review currently shows per-panel status + notes, not the original-query ↔ converted-query ↔ live chart triptych from the design. (Medium effort: execute the converted query and render a small chart per panel.)
2. **Settings / connection surface** — connection is via backend `.env`; there's no in-UI screen to enter SigNoz URL + key / Grafana. (Productization.)
3. **Docker-compose packaging** — runs as two dev processes (backend `tsx`, frontend `vite`); the "one `docker compose up`" story (app container + signoz-mcp sidecar) isn't built.
4. **Grafana alert-rule migration** — roadmap in the docs; not v1. AgentOtto can author alerts conversationally, but there's no bulk Grafana-alert → SigNoz-alert path.
5. **Deeper agent dashboard authoring** — AgentOtto reliably authors alerts; complex `create_dashboard` payloads via chat are still best done through the deterministic Migrate/SLO surfaces.
6. **tRPC** — the design specified tRPC v11; implemented as plain Fastify REST (functionally equivalent, typed client not shared).

_Not gaps (deliberately out of v1 scope per PRODUCT.md §4): LogQL panel conversion, template-variable expansion beyond the service selector, Datadog/New Relic sources, local-LLM option._

---

## 4. Track 02 fit (why this scores)

Track 02 rewards **OpenTelemetry instrumentation** and **dashboard build**:
- **Dashboard build is literal** — Otto generates, validates, and reasons about SigNoz dashboards through the full Query Builder surface, and does the migration the SigNoz docs say must be done "by hand."
- **Instrumentation is twofold** — the readiness/coverage engine *reasons about* instrumentation (what exists, what's missing, the collector fix), and the platform is *exemplary instrumentation*: every feature traced, metered, and dashboarded in the same SigNoz it manages, demoable live as `otto` + `otto-web` services.

## 5. Suggested demo flow (≈4 min)
1. **Overview** — "connected, N services, Otto kept separate." 
2. **Coverage audit** — "these services are missing logs in SigNoz" (honest gap-finding).
3. **Migrate** — pick the Demo Dashboard → watch the **live steps** stream → approval gate → **replication check** → open in SigNoz.
4. **SLO copilot** — pick checkout/PlaceOrder → **live analysis steps** → SRE reasoning (binding SLI = latency, alternatives) → approve → dashboard + alert.
5. **AgentOtto** — ask "which services have the highest error rate?" then "create an alert for that" → **approval card** → created.
6. **Otto Ops** — flip to the self-observability dashboard: "the tool that manages your observability is itself observable" — show the `otto.run` trace of the migration you just did.

## 6. Honest caveats
- The agent tail is non-deterministic (temperature 1); deterministic panels are the reliable core.
- Data plane (metrics/traces/logs ingestion) is the OTel-demo's existing setup — Otto starts where SigNoz's migration docs end (dashboards/SLOs/investigation), by design.
- Visual polish is unverified by me; item #2.1 is the top pre-submission task.
