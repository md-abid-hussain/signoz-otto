# Otto — Roadmap & Cleanup Plan (`after-hack` branch)

> Goal: take the hackathon build to a **simpler, concrete, correct** version — cut dead code,
> collapse superseded paths, patch security advisories — without losing any working feature.
> Grounded in the original intent ([v2/PRODUCT.md](v2/PRODUCT.md), [v2/TECH.md](v2/TECH.md)) and the
> code as it actually shipped.

## Where the code diverged from the v2 design (why there's cruft)

The v2 docs planned a **tRPC + LangGraph `StateGraph`** engine with shared workspace types. The build
pragmatically simplified to **Fastify + plain SSE + `deepagents`**, with a deterministic streaming
migrator (`fullmigrate.ts`) instead of the full graph. That was the right call — but it left the
first-attempt code stranded in the tree:

- `engine/graph.ts` — the old LangGraph `StateGraph`. **Superseded** by `fullmigrate.ts`. Dead.
- `signoz/serialize.ts` — query/widget serializers for the graph path. **Unused.** Dead.
- `backend/src/scripts/*` — 10 CLI/smoke drivers used while building the engine. Not part of the app.
- Non-streaming routes `/api/migrate`, `/api/slo`, `/api/readiness` — **superseded** by the `*/stream`
  versions the UI actually calls. Dead.
- `callRaw`, `mcp.read`/`mcp.write` maps — leftovers from the curated read/write split; the agent now
  takes `mcp.raw` + a verb-based gate. Dead.

## Target architecture (what stays — the whole working product)

```
frontend (React + React-Router + TanStack Query, Vite)
  8 surfaces: Overview · Coverage audit · Migrate · SLO · AgentOtto · Runs · Otto Ops · About
      │  /api  +  SSE (/migrate/stream, /slo/stream)
backend (Fastify)
  ├─ engine/fullmigrate.ts   deterministic Grafana→SigNoz migration (+ agent tail)
  │   ├─ mapper/promql.ts     PromQL → Query Builder (unit-tested)
  │   ├─ agent/translate.ts   LLM for the hard panels
  │   └─ agent/match.ts       rename/semantic recovery
  ├─ engine/slo.ts           SLO proposal + dashboard/alert build
  ├─ engine/opsdash.ts       self-observability dashboard
  ├─ agent/askact.ts         AgentOtto — deepagents over the full MCP surface, gated writes
  ├─ readiness/index.ts      live field/metric checks
  ├─ ingest/grafana*.ts      dashboard parse + live Grafana pull
  ├─ signoz/mcp.ts           the one SigNoz boundary (MCP over HTTP)
  └─ otel/                   self-instrumentation (backend + LangGraph bridge)
```

Kept intact: every surface, streaming migration/SLO, the approval gate, self-observability. Nothing a
user or judge sees is removed — only code nothing reaches.

## Plan

### Phase A — no live services needed (do now)
1. **Remove dead files** — `scripts/`, `engine/graph.ts`, `signoz/serialize.ts`, `deprecated/`; trim
   `samples/` to the fixtures the tests/demo actually use.
2. **Simplify code** — drop the superseded `/api/migrate`, `/api/slo`, `/api/readiness` routes and their
   unused `api.ts` client methods; remove `callRaw` + the unused `read`/`write` maps from `mcp.ts`.
3. **Patch vulnerabilities** — bump `vitest` (backend; pulls fixed `vite`/`esbuild`/`launch-editor`/
   `@hono/node-server`) and `vite` + `react-router` (frontend). Target: `npm audit` clean.
4. **Green the gates** — `tsc --noEmit` (both), `vitest run` (27 unit tests — no live services). Commit.

### Phase B — needs SigNoz + Grafana ON (after restart)
5. **Live smoke** — start backend, `/api/health`; run one Grafana→SigNoz migration end-to-end; drive an
   AgentOtto write through the approval card; confirm `otto`/`otto-web` OTel lands in SigNoz.
6. **Final pass + commit** — fix anything the live run surfaces; update README/docs; open PR from
   `after-hack`.

## Security advisories addressed (Dependabot)

Backend: **7 → 0** vulnerabilities (`vitest 2 → 4` pulls patched vite/esbuild/launch-editor;
`npm audit fix` cleared `@hono/node-server`).

| # | Package | Severity | Outcome |
|---|---|---|---|
| 3 | vitest (UI arbitrary file read/exec) | Critical | ✅ fixed — vitest 4 |
| 4 | vite (`server.fs.deny` bypass, Windows) | High | ✅ fixed — via vitest 4 |
| 2 | vite (path traversal, `.map`) | Moderate | ✅ fixed — via vitest 4 |
| 1 | esbuild (dev-server request read) | Moderate | ✅ fixed — via vitest 4 |
| 5 | launch-editor (NTLMv2 disclosure) | Moderate | ✅ fixed — via vitest 4 |
| 6 | @hono/node-server (path traversal) | Moderate | ✅ fixed — `npm audit fix` |
| 7 | react-router (RSC CSRF bypass) | High | ⚠️ **not applicable** — see below |

**react-router (#7):** there is a version squeeze — ≤7.17.0 carries an *applicable* open-redirect
advisory (`<Link>`/`useNavigate`, which the app uses), fixed only in **7.18.0+**; 7.12.0–8.2.0 carries
the RSC-CSRF advisory, and no stable 8.x exists. We stay on **latest 7.18.1** (fixes the applicable
open-redirect). The remaining RSC-CSRF advisory does **not** apply: this is a plain SPA using only
`BrowserRouter`/`Routes`/`Route`/`Link`/`NavLink`/`useNavigate` — no RSC mode, data routers, loaders,
or actions. **Action:** dismiss the GitHub alert as "not affected" (or wait for a patched 8.x).

## Deferred (documented, not in this pass)

- AgentOtto **edit-before-approve** path (framework supports `edit`; UI/backend do approve/reject only).
- General **OTLP metric-name translation** (dotted↔underscored) beyond `_total` stripping.
- `GRAFANA_TOKEN` is honored in code but should be documented in `.env.example` for secured Grafana.

## Non-goals (unchanged from v2 §4)

No pipeline migration, no unattended writes, no full SLO-management suite — approval gates stay the product.
