# Otto — the missing teammate for self-hosted SigNoz

> v2 product definition — problem statement, proposed platform, and user story.
> Feature-level; technical design in [DESIGN.md](DESIGN.md) + [TECH.md](TECH.md). Date: 2026-07-25.
> Supersedes the v1 framing in ../PLAN.md / ../SPEC.md (single-feature migration tool); kept for comparison.
>
> **Status:** the migration and SLO workflows have been **validated end-to-end by hand** against a live SigNoz + the OpenTelemetry demo (full 7-panel dashboard migrated with fidelity proof; SLO dashboard + Slack alert created) — see [FLOW-NOTES.md](FLOW-NOTES.md). Accepted build decisions: agentic engine on **LangGraph.js** with interrupt-based approval; SigNoz reached via the **SigNoz MCP server over HTTP** (`SIGNOZ-API-KEY` header) — shipped as a sidecar or an existing endpoint; a single **admin/write API key** with **every write confirmation-gated**; LLM = **OpenAI `gpt-5.6-terra`** (provider-swappable).

---

## 1. Problem statement

SigNoz gets teams 80% of the way to great observability — and leaves the hardest 20% as manual, expert-judgment work:

**a) Moving in is manual where it hurts most.** SigNoz's migration docs automate the *pipes* (repoint collectors; metrics, logs, and traces flow). But for dashboards, their own docs say it plainly: *"Grafana dashboards need to be recreated in SigNoz."* A team with years of accumulated Grafana dashboards — each panel encoding a lesson from a past incident — faces rebuilding them by hand, in a different query system, with no way to know what will survive.

**b) Nobody tells you what will break — or whether it worked.** During migration, metric names silently change (Prometheus exporters → OTel receivers renames `http_request_duration_seconds` to `http.server.request.duration`). Copied queries return empty charts with no error. There is no readiness check before you commit, and no verification after. SigNoz's own troubleshooting docs acknowledge the symptom ("metric values don't match"); nothing prevents it.

**c) Deciding what "reliable" means is left entirely to you.** SigNoz publishes guides on SLO monitoring — and ships no SLO feature. Defining a good SLO requires studying weeks of your real traffic and making a judgment call. Most teams never start, so they alert on raw thresholds (CPU > 80%) that page humans without protecting users.

**d) Self-hosted users have no AI teammate.** SigNoz Cloud ships Noz — an in-product AI that investigates telemetry and creates dashboards/alerts conversationally. Self-hosted SigNoz, the open-source deployment this community runs, has no equivalent. The building blocks exist (SigNoz's own open-source MCP server), but assembling them into a usable, safe teammate is left to each user.

**One sentence:** adopting and operating SigNoz demands expert-judgment work — knowing what your telemetry can support, moving in what you had, defining what reliable means, and investigating day-to-day — that the product doesn't automate, and for self-hosted users there is no AI help at all.

---

## 2. Proposed solution — one platform, one engine, four surfaces

**Otto is a self-hosted agentic copilot for SigNoz**: a small stack you run next to your SigNoz instance (one `docker compose up` — the Otto app plus the SigNoz MCP server over HTTP; if your SigNoz already exposes MCP, point at it instead). You enter SigNoz URL + API key. Inside it, one LangGraph agent engine — which pauses for your approval before any write — powers four user-facing capabilities. **v1 build status is marked per surface** (full detail in DESIGN §1.1):

### Surface 1 — Readiness & telemetry audit  · **v1: built** (proven manually)
Point it at your Grafana dashboards (file upload or direct Grafana connection) and your SigNoz instance. Before anything is touched, you get a blast-radius report: every metric your dashboards depend on, checked against what actually exists in SigNoz —
- **matches** (will migrate cleanly),
- **renamed** (exists under a different OTel name; mappable, with the mapping shown),
- **missing** (no data at all — these panels will be blank, and here's the collector change that would fix it).

This same audit engine answers the SLO surface's feasibility questions ("you want a latency SLO but emit no latency histogram") — it is the shared first stage of every workflow, and available standalone as "audit my instance."

### Surface 2 — Dashboard migration (the deep workflow)  · **v1: built** (full dashboard proven, fidelity-checked)
Converts Grafana dashboards to SigNoz dashboards, panel by panel:
- **Mechanical constructs convert deterministically** (tested code, not AI) — filters, rates, percentiles, group-bys, top-N.
- **The agent handles what code can't**: semantically matching renamed metrics against the live instance, translating exotic query constructs with a stated closest-equivalent, and repairing queries that fail validation.
- **Every panel is verified by execution**: the generated query runs against your real data, and the review screen shows original query ↔ converted query ↔ a live preview chart, side by side.
- **Nothing is silently dropped**: every panel ends in an explicit state — verified, verified-with-renames (reasons shown), needs-review (best attempt + explanation), or unsupported (original query preserved).
- Nothing is written to SigNoz until you approve.

### Surface 3 — SLO copilot (evidence-based reliability targets)  · **v1: working slice** (one operation proven: dashboard + alert)
The agent studies your actual traffic history and **proposes** an SLO — "checkout-api served 99.4% of requests under 800ms; I propose 99% under 800ms over 30 days, which allows ~7.2 hours of degraded behavior per month" — with its evidence shown. You edit the target, approve, and it creates the SLI dashboard, error-budget view, and alert in SigNoz. The judgment call that stops most teams from ever adopting SLOs is exactly the part the agent does.

### Surface 4 — Ask & Act (the self-hosted teammate)  · **v1: roadmap-minimal** — planned on `deepagents` (LangGraph harness) + SigNoz MCP tools + agent-skills
A conversational surface over the same engine: ask questions about your telemetry in plain English ("why is checkout p99 up since yesterday's deploy?") and the agent investigates across traces, logs, and metrics via SigNoz MCP, answering with linked evidence. When the conversation leads to action — "create an alert for that" — the action goes through the **same approval gate as every workflow**: proposed change shown, nothing created until you confirm. This brings the Noz experience to self-hosted SigNoz — with an explicit permission model Cloud users don't even get.

### Cross-cutting properties (every surface, no exceptions)

- **Human-in-the-loop by construction.** The agent graph *pauses before any write* (LangGraph interrupt) and cannot proceed until you approve the previewed change; destructive actions (delete) are separately confirmed. Reads are free; writes are gated. A single admin/write key is used — the confirmation gate is the control.
- **Evidence and scoring.** Every agent output is verified by executing real queries, and every run produces a scored receipt (panels verified, items needing review, tokens spent, duration). Agent claims are checked, not trusted.
- **Fully self-observable.** The platform instruments itself with OpenTelemetry and sends its own traces, metrics, and logs to the same SigNoz instance it manages. Every migration is a trace; every LLM call carries token and cost metrics; a built-in "Otto Ops" dashboard shows the platform's own behavior. The tool that manages your observability is itself completely observable.
- **Privacy by architecture.** Self-hosted: your telemetry never leaves your infrastructure — with one deliberate exception, the LLM API. That boundary is designed: the agent's prompts contain metric names, label keys, query shapes, and aggregate statistics — never raw log bodies, span payloads, or data values. Bring your own LLM key.
- **Extensible by design.** Surfaces are playbooks on a common engine (analyze → propose → approve → apply → verify). New playbooks — deploy guardian, log-pipeline migration, Datadog/New Relic sources — plug in without touching the core. Visible in the UI as roadmap.

---

## 3. Priya's week (the user story)

Priya is a backend engineer at a 30-person startup. Her team ran Prometheus + Grafana for three years — 12 dashboards, ~120 panels — and has just moved their telemetry pipelines to self-hosted SigNoz following the official docs. Data is flowing. Now the part the docs leave to her.

**Monday, 10:00 — Connect.** She starts Otto next to SigNoz (one `docker compose up`), enters her SigNoz URL + API key. It verifies: "Connected — 14 services reporting, 210 metrics, traces and logs flowing." She points it at Grafana too — one URL + token — and it pulls all 12 dashboards itself.

**10:05 — Readiness.** Before touching anything, Otto reports: *"Your 12 dashboards use 71 distinct metrics. 49 exist in SigNoz with matching names. 15 exist under different OTel names — I can map them (examples shown). 7 are missing entirely — the JMX metrics stopped when you dropped the exporter; the 9 panels using them will be blank. Here's the receiver config that would restore them."* For the first time, she knows exactly what the move will cost before committing.

**10:20 — Migrate.** She runs the first dashboard. Twelve panel cards process live — most convert instantly; on one, the agent explains: *"No exact match for `http_requests_total`; found `http.server.request.count` with the same labels and rate shape — matched via OTel naming convention."* Each finished panel shows the old query, the new query, and a live chart from her real data drawing the same curve Grafana drew. One panel is honestly flagged: *"`label_replace()` has no SigNoz equivalent — closest translation applied, marked for review."* She reviews the evidence, clicks **Apply**. The dashboard exists in SigNoz. Four minutes instead of an afternoon. She batches through the rest before lunch.

**14:00 — SLO.** Otto offers: *"Want a reliability target for checkout-api?"* It reads her traffic history and proposes 99% of requests successful and under 800ms over 30 days — showing the distribution it based that on. She tightens 800ms to 750ms, approves. The SLI dashboard, error-budget view, and alert appear in SigNoz.

**Thursday, 09:40 — Ask & Act.** After Wednesday's deploy, checkout feels slow. She asks Otto: *"Why is checkout-api p99 up since yesterday afternoon?"* The agent investigates via SigNoz — traces show payment-gateway calls retrying 3×, latency concentrated after the 16:10 deploy — and answers with links to the exact traces. She replies, "alert me if that retry rate spikes again." Otto shows the alert rule it intends to create; she approves; it's live. On Cloud this teammate is called Noz. Priya self-hosts — now she has one too, with an approval gate on every change.

**Friday — Receipts.** Her tech lead asks what the AI actually did this week. Priya opens the Otto Ops dashboard — in SigNoz itself: every run as a trace, every panel a span, scores per migration (118/120 panels verified, 2 needs-review), total LLM spend for the week: $1.87. Nothing happened that isn't recorded, scored, and approved.

---

## 3a. Validation status — what's proven vs planned (2026-07-25)

Established by hand against a live SigNoz + the OpenTelemetry demo, before writing product code (evidence: [FLOW-NOTES.md](FLOW-NOTES.md)):

| Capability | Status | Evidence |
|---|---|---|
| Readiness / grounding (rename detection, field-context resolution) | ✅ proven | run 1–2: mapped `traces_span_metrics_*` → `traces.span.metrics.*`, caught the silent-null field-context trap |
| Migration — full dashboard | ✅ proven | run 2: 7/7 query panels, 14 targets, 0 silently dropped; call-rate + avg-latency fidelity-matched to Prometheus to the decimal |
| Honest handling (renames, unsupported quantiles, intent-vs-bug) | ✅ proven | run 2: p999 dropped-with-note; inconsistent grouping fixed-and-flagged |
| SLO copilot — evidence-based proposal + artifacts | ✅ proven | run 3: proposed 95%/2.5s/30d from real traffic; created 4-panel SLO dashboard + Slack fast-burn alert |
| Self-observability (Otto Ops dashboard) | ⏳ designed, not yet built | DESIGN §8 |
| Ask & Act conversational surface | ⏳ roadmap-minimal | DESIGN §1.1 |
| Template variables, LogQL, exotic panels | ⛔ out of v1 scope | §4 below |

## 4. What it deliberately does not do

- **No pipeline migration** — getting telemetry flowing stays with SigNoz's docs; Otto starts where their automation ends.
- **No unattended writes** — there is no "auto-apply" mode; approval gates are the product, not a setting.
- **v1 scope honesty** — PromQL/metrics dashboards (Loki/LogQL panels flagged, not converted); Grafana template variables substituted with fixed values; exotic panel types preserved-but-flagged; one SLO happy path, not a full SLO management suite; missing-metric fixes are suggested configs, not auto-applied changes.

## 5. Why this doesn't exist today

| Existing thing | What it does | What it doesn't |
|---|---|---|
| SigNoz migration docs | Automate pipelines | Dashboards: "recreate by hand"; no readiness, no verification |
| Noz (SigNoz Cloud) | Conversational creation & investigation | Cloud-only; creates from description, no migration, no fidelity concept, no approval gates |
| SigNoz MCP + skills | Raw tools for external AI assistants | Not a product: no workflows, no verification, no UI, no permission model |
| SigNoz dashboard templates | Pre-built dashboards if yours happens to match | Doesn't migrate *your* dashboards |
| OTel Weaver / Cost Meter | Schema validation / cost analytics | Nothing about migration, SLOs, or an assistant |

The empty square: **reading a team's existing artifacts, proving equivalence with evidence, deciding with judgment, and acting only with permission — packaged for self-hosted SigNoz.**

## 6. Next iterations (roadmap, not v1)

Deploy guardian (deploy markers ↔ regressions) · log-pipeline migration (LogQL → SigNoz pipelines) · Datadog/New Relic dashboard sources · alert-rule bulk migration · local-LLM option for zero-egress environments · scheduled re-audits ("what drifted since last month?").

## 7. Hackathon fit (one paragraph)

Track 02 rewards OpenTelemetry instrumentation and dashboard build. Otto's dashboard half is literal — it generates, verifies, and reasons about dashboards through the full Query Builder surface. Its instrumentation half is twofold: the readiness engine *reasons about instrumentation* (what exists, what's missing, what to add, with concrete collector configs), and the platform itself is *exemplary instrumentation* — every feature traced, metered, and dashboarded in the same SigNoz it manages, demo-able live.
