# Otto frontend

The multi-surface product shell for Otto — Vite + React + TypeScript + Tailwind v4 + TanStack Query, in an "observatory" dark theme (signal-amber / phosphor-green duotone, IBM Plex Mono readouts, Chivo display).

## Surfaces
- **Overview** — connection status + the one-engine / four-surface pitch
- **Migrate** — Grafana→SigNoz: pipeline stepper, readiness, per-panel outcomes, receipt, and the human approval gate → replication check
- **SLO copilot** — live evidence → evidence-based objective → approve → dashboard (+ alert)
- **Ask & Act** — deepagents teammate chat over live SigNoz (read-only over HTTP; writes gated)
- **Otto Ops** — self-observability: the span waterfall Otto emits + build-the-ops-dashboard

## Run
The backend (Fastify) must be running on port 8010:

```bash
cd ../backend && PORT=8010 npx tsx --env-file=.env src/server.ts
```

Then the frontend dev server (proxies `/api` → `:8010`):

```bash
npm install
npm run dev        # http://localhost:5273
```

Set `OTTO_API` to point the dev proxy at a non-default backend origin.

## Build
```bash
npm run build      # tsc + vite build → dist/
```
