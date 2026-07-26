# Blog & Video Guide — Otto (Agents of SigNoz)

Everything you need to write the mandatory blog and record the ≤3-min video. Write from **your**
experience (the judges explicitly reward authentic, hands-on detail over summaries) — this doc gives
you the structure, the specific SigNoz details worth featuring, and a screenshot checklist.

---

## PART A — The Blog

**Requirements (from the official guide):** 1,000–1,500 words · Medium / Dev.to / Substack (not
LinkedIn/raw docs) · authentic hands-on experience · real screenshots of SigNoz · verified technical
claims · actionable takeaways. **Write a NEW post** for the hackathon (pre-challenge blogs don't count).

### Suggested title options
- *"I gave self-hosted SigNoz an AI copilot — here's what I learned about its MCP server and Query Builder"*
- *"Migrating Grafana dashboards to SigNoz with an agent (and making the agent observable in SigNoz)"*
- *"Building Otto: an agentic copilot that reads, reasons, and acts on SigNoz — with a human gate"*

### Structure (map to the guide's Hook → Context → Body → Learnings → Conclusion)

**1. Hook (2–3 sentences).** Lead with the real problem. Suggested angle:
> SigNoz's own docs say Grafana dashboards must be *"recreated by hand."* There's no readiness check
> before you commit, and self-hosted users don't get the Cloud "Noz" AI. I built Otto to close that gap —
> and the most interesting part wasn't the AI, it was everything I learned about SigNoz's MCP server.

**2. Context.** What Otto is (one paragraph): a self-hosted agentic copilot with four jobs — audit
telemetry, migrate dashboards, define SLOs, investigate — over the live SigNoz MCP, with a human
approval gate on every write. One sentence on the stack (LangGraph + deepagents + the SigNoz MCP over
HTTP + React). Keep it short; the body is where the value is.

**3. Main body — how you actually used SigNoz** (this is the core; be specific). Pick 3–4 of these,
each with a short code/JSON snippet + a screenshot. These are the "only-if-you-built-it" details:

- **The MCP server is the whole control path.** Otto talks to SigNoz *only* through the SigNoz MCP
  server over HTTP (`:8000/mcp`) with a `SIGNOZ-API-KEY` header — verified it returns **401 without
  the header**. Reads (`list_services`, `list_metrics`, `get_field_keys/values`, `execute_builder_query`,
  `aggregate_traces`) and writes (`create_dashboard`, `create_alert`) all go through it.
- **The silent-null trap in the Query Builder.** Grouping on a context-ambiguous field returns
  **HTTP 200 + rows scanned + `aggregations: null`** — no error, just an empty chart. The fix:
  call `get_field_keys` and attach the explicit `fieldContext` (resource vs attribute) to every
  groupBy/filter key. This one finding shaped the whole readiness engine.
- **Histogram percentiles → traces.** `histogram_quantile(...)` over a `*_bucket` metric returned a
  500 in the tested build, so Otto falls back to the traces signal: `p95(duration_nano)`. Worth
  showing the before/after.
- **The `create_alert` schema is stricter than the docs.** Three gotchas that cost real time:
  `evaluation` is **top-level** (not under `condition`); every threshold spec **requires
  `recoveryTarget`** (the MCP tool's zod is stricter than the raw API); and you must **not** put
  `order`/`limit`/`stepInterval` on formula specs or it 400s. (Great "learnings" material.)
- **Self-instrumentation — the tool watching itself.** Otto exports its own OpenTelemetry to the same
  SigNoz it manages: it shows up as the services **`otto`** (backend, with an `otto.run →
  panel.migrate → llm.call` trace tree) and **`otto-web`** (frontend RUM). Because LangChain.js has
  **no built-in OTLP exporter** (that's Python-only), I bridged its callback system to OTel spans so
  the agent's LLM/tool calls appear as spans. This is the Track-02 "exemplary instrumentation" story.
- **Coverage audit found a real gap.** Running `get_field_values(service.name)` per signal, Otto
  showed that `frontend`, `flagd`, `image-provider`, and `telemetry-docs` had traces + metrics in
  SigNoz but their **logs only reached OpenSearch**, not SigNoz — a collector-pipeline gap Otto
  surfaces (it doesn't fix ingestion; it makes the gap visible).

**4. Learnings/Takeaways.** Be honest — the guide rewards this:
- The MCP server made the agent "native" to SigNoz but its zod validation is stricter than the HTTP
  API, so schema-author-and-verify loops matter.
- Deterministic-first, agent-for-the-tail beats "let the LLM do everything" — the agent runs at
  temperature 1 and is non-deterministic; the tested mapper is the reliable core.
- Human-in-the-loop isn't a setting, it's the product: reads free, every write gated.
- Making the agent observable *in the same SigNoz* turned debugging the agent into… using SigNoz.

**5. Conclusion.** One takeaway (e.g., "the SigNoz MCP + skills are a genuinely good substrate for an
agent, if you respect the Query Builder's field-context rules") + links: the repo, SigNoz MCP docs,
the OTel demo.

### Screenshot checklist (capture these live)
1. SigNoz **Services** list showing `otto` **and** `otto-web` alongside the demo services.
2. The **`otto.run` trace waterfall** (otto.run → panel.migrate → llm.call) in SigNoz Traces.
3. A **migrated dashboard** in SigNoz (faithful title/sections/service.name variable).
4. The **SLO dashboard** (SLI % + error budget) Otto created.
5. Otto's **Coverage audit** page showing a missing-logs gap.
6. The **AgentOtto approval card** (a gated write awaiting Approve).
7. The **Otto Ops** dashboard.

---

## PART B — The Video (≤ 3 minutes)

Cover: **About · Tech stack & architecture · Demo · Learning/growth (optional).** Screen-record the
live app + SigNoz; talk over it. Suggested beat sheet (aim ~2:45):

| Time | Beat | Say / show |
|---|---|---|
| 0:00–0:20 | **Hook + about** | "SigNoz gets you 80% there; the last 20% — migrating dashboards, defining SLOs, investigating — is manual, and self-hosted users get no AI. Otto is that missing 20%." Show the **Overview** page (connected, services, Otto held separate). |
| 0:20–0:45 | **Tech stack & architecture** | One line: React + React-Router front end → Fastify + SSE → a LangGraph engine + deepagents, over the **SigNoz MCP server (HTTP)**, with OpenTelemetry on everything. Flash the architecture diagram from the README. |
| 0:45–1:30 | **Demo 1 — Migrate** | Pick the Demo Dashboard → watch the **live steps stream** (parse → readiness → per-panel → assemble → verify) → the **approval gate** → **replication check** → open the created dashboard in SigNoz. Emphasize "nothing written until I approve." |
| 1:30–2:05 | **Demo 2 — SLO + AgentOtto** | SLO: pick checkout/PlaceOrder → the **SRE analysis** (binding SLI = latency, alternatives, error budget). Then AgentOtto: "which services have the highest error rate?" → "create an alert for that" → **approval card** → created. |
| 2:05–2:35 | **Demo 3 — self-observability** | Flip to **Otto Ops** / SigNoz: "the tool that manages your observability is itself observable" — show `otto` + `otto-web` services and the `otto.run` trace of the migration you just ran. This is the Track-02 money shot. |
| 2:35–2:55 | **Learning/growth** | One honest line: e.g., "the biggest lesson was respecting the Query Builder's field-context rules — a 200 with null aggregations taught me that the hard way." |

**Recording tips:** start the backend with `OTTO_OTEL=1` and run one migration *before* recording so
Otto Ops has data. Keep it to one take per demo; the live-step streaming reads great on video. Do a
dry run of each click path first (the agent tail varies run-to-run).

---

## What to focus on (priorities)
1. **The SigNoz usage must be specific and real** — the MCP path, the Query Builder field-context
   trap, the create_alert schema, and the self-instrumentation are your strongest, most authentic material.
2. **The self-observability angle is the Track-02 differentiator** — lead with it in both blog and video.
3. **Honesty reads as credibility** — mention what failed (silent nulls, schema 400s, agent variance).
4. **Screenshots/recording of real SigNoz** — not mockups. Capture the checklist above before writing.
