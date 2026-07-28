// Otto HTTP API — turns the engine into a service the UI drives (all four surfaces).
// Endpoints:
//   GET  /api/health                 → ok
//   GET  /api/connect                → verify SigNoz (service count) + Grafana reachability
//   GET  /api/grafana/dashboards     → list Grafana dashboards (live connect)
//   POST /api/readiness              → { uid? | dashboard } → readiness report
//   POST /api/migrate                → { uid? | dashboard, apply? } → per-panel outcomes (+ created id if apply)
//   POST /api/slo                    → { service, operation, timeRange?, apply?, channel? } → evidence + proposal (+ ids if apply)
//   POST /api/ops/dashboard          → { apply? } → the Otto Ops self-observability dashboard (+ created id if apply)
//   POST /api/ask                    → { question } → Ask & Act read-only answer over live SigNoz
import { initOtel, ottoAgentTracer } from './otel/index.js';
if (process.env.OTTO_OTEL) initOtel(); // self-instrument the API + engine when enabled
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Command } from '@langchain/langgraph';
import { connectSigNoz } from './signoz/mcp.js';
import { listGrafanaDashboards, fetchGrafanaDashboard } from './ingest/grafanaClient.js';
import { parseGrafanaDashboard } from './ingest/grafana.js';
import { runReadiness } from './readiness/index.js';
import { fullMigrate } from './engine/fullmigrate.js';
import { analyzeSlo, proposeSlo, applySlo, latencyTrend, analyzeSloReasoning } from './engine/slo.js';
import { buildOttoOpsDashboard } from './engine/opsdash.js';
import { buildAskAct } from './agent/askact.js';

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

/** resolve a dashboard JSON from either an uploaded body or a Grafana uid */
async function resolveDashboard(body: { uid?: string; dashboard?: unknown }): Promise<unknown> {
  if (body.dashboard) return body.dashboard;
  if (body.uid) return fetchGrafanaDashboard(body.uid);
  throw new Error('provide { uid } or { dashboard }');
}

app.get('/api/health', async () => ({ ok: true, service: 'otto' }));

app.get('/api/connect', async (_req, reply) => {
  try {
    const mcp = await connectSigNoz();
    const res = await mcp.call<{ data?: { serviceName?: string }[] }>('list_services', { timeRange: '6h' });
    await mcp.close();
    const rows = Array.isArray(res?.data) ? res.data : [];
    const names = rows.map((s) => String(s.serviceName ?? '')).filter(Boolean);
    const ottoPresent = names.includes(process.env.OTTO_SERVICE_NAME ?? 'otto');
    const services = names.filter((n) => n !== (process.env.OTTO_SERVICE_NAME ?? 'otto')).length;
    let grafana: { ok: boolean; count?: number; error?: string } = { ok: false };
    try { grafana = { ok: true, count: (await listGrafanaDashboards()).length }; }
    catch (e) { grafana = { ok: false, error: (e as Error).message }; }
    return { signoz: { ok: true, services, otto: ottoPresent }, grafana };
  } catch (e) {
    return reply.code(502).send({ signoz: { ok: false, error: (e as Error).message } });
  }
});

app.get('/api/grafana/dashboards', async (_req, reply) => {
  try { return { dashboards: await listGrafanaDashboards() }; }
  catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});

// in-memory run history (the "Receipts" story — DESIGN §4.7 list-receipts). Last 50 runs.
interface RunRecord {
  id: string; at: number; playbook: 'migration' | 'slo';
  title: string; summary: string; applied: boolean; webUrl?: string;
  stats: Record<string, number | string>;
}
const runs: RunRecord[] = [];
function recordRun(r: Omit<RunRecord, 'id' | 'at'>): void {
  runs.unshift({ id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()), at: Date.now(), ...r });
  if (runs.length > 50) runs.length = 50;
}
app.get('/api/runs', async () => ({ runs }));

// live service inventory — the observed application, with Otto (the copilot) held separate
const OTTO_SERVICE = process.env.OTTO_SERVICE_NAME ?? 'otto';
interface Svc { name: string; callRate?: number; errorRate?: number; p99Ns?: number; numCalls?: number }

app.get('/api/signoz/services', async (_req, reply) => {
  try {
    const mcp = await connectSigNoz();
    const res = await mcp.call<{ data?: Record<string, unknown>[] }>('list_services', { timeRange: '6h' });
    await mcp.close();
    const rows = Array.isArray(res?.data) ? res.data : [];
    const map = (s: Record<string, unknown>): Svc => ({
      name: String(s.serviceName ?? ''),
      callRate: Number(s.callRate ?? 0), errorRate: Number(s.errorRate ?? 0),
      p99Ns: Number(s.p99 ?? 0), numCalls: Number(s.numCalls ?? 0),
    });
    const all = rows.map(map).filter((s) => s.name);
    const copilot = all.find((s) => s.name === OTTO_SERVICE) ?? null;
    const observed = all.filter((s) => s.name !== OTTO_SERVICE).sort((a, b) => (b.callRate ?? 0) - (a.callRate ?? 0));
    return { observed, copilot };
  } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});

// telemetry coverage audit — which services emit which signals (traces / metrics / logs).
// This is Surface 1 at the service level: Otto can't fix ingestion, but it shows the gap.
function deepStrings(obj: unknown, key: string): string[] {
  if (obj == null || typeof obj !== 'object') return [];
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec[key]) && (rec[key] as unknown[]).every((v) => typeof v === 'string')) return rec[key] as string[];
  for (const v of Object.values(rec)) { const hit = deepStrings(v, key); if (hit.length) return hit; }
  return [];
}

app.get('/api/audit/coverage', async (_req, reply) => {
  try {
    const otto = process.env.OTTO_SERVICE_NAME ?? 'otto';
    const mcp = await connectSigNoz();
    const svcRes = await mcp.call<{ data?: Record<string, unknown>[] }>('list_services', { timeRange: '6h' });
    const health = new Map<string, { callRate: number; errorRate: number }>();
    for (const s of Array.isArray(svcRes?.data) ? svcRes.data : []) health.set(String(s.serviceName ?? ''), { callRate: Number(s.callRate ?? 0), errorRate: Number(s.errorRate ?? 0) });
    const signalSet = async (signal: 'traces' | 'metrics' | 'logs') => {
      try { return new Set(deepStrings(await mcp.call('get_field_values', { signal, name: 'service.name' }), 'stringValues')); }
      catch { return new Set<string>(); }
    };
    const [traces, metrics, logs] = await Promise.all([signalSet('traces'), signalSet('metrics'), signalSet('logs')]);
    await mcp.close();

    const universe = [...new Set([...traces, ...metrics, ...logs, ...health.keys()])].filter(Boolean).sort();
    const isSelf = (n: string) => n === otto || n === `${otto}-web`;
    const row = (name: string) => ({
      name, traces: traces.has(name), metrics: metrics.has(name), logs: logs.has(name),
      callRate: health.get(name)?.callRate, errorRate: health.get(name)?.errorRate,
    });
    const services = universe.filter((n) => !isSelf(n)).map(row);
    const self = universe.filter(isSelf).map(row);
    const gaps = services.filter((s) => !(s.traces && s.metrics && s.logs))
      .map((s) => ({ service: s.name, missing: (['traces', 'metrics', 'logs'] as const).filter((k) => !s[k]) }));
    return { services, self, gaps, totals: { traces: traces.size, metrics: metrics.size, logs: logs.size } };
  } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});

app.get('/api/signoz/operations', async (req, reply) => {
  try {
    const service = (req.query as { service?: string })?.service;
    if (!service) throw new Error('provide ?service=');
    const mcp = await connectSigNoz();
    const res = await mcp.call<unknown>('get_service_top_operations', { service, timeRange: '6h' });
    await mcp.close();
    const arr = (Array.isArray(res) ? res : (res as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[];
    const operations = arr.map((o) => ({ name: String(o.name ?? ''), p95Ns: Number(o.p95 ?? 0), numCalls: Number(o.numCalls ?? 0) })).filter((o) => o.name);
    return { service, operations };
  } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});

app.get('/api/signoz/channels', async (_req, reply) => {
  try {
    const mcp = await connectSigNoz();
    const res = await mcp.call<{ data?: Record<string, unknown>[] }>('list_notification_channels', {});
    await mcp.close();
    const rows = Array.isArray(res?.data) ? res.data : [];
    const channels = rows.map((c) => ({ name: String(c.name ?? ''), type: String(c.type ?? '') })).filter((c) => c.name);
    return { channels };
  } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
});

app.post('/api/ops/dashboard', async (req, reply) => {
  try {
    const apply = !!(req.body as { apply?: boolean })?.apply;
    const dash = buildOttoOpsDashboard();
    if (!apply) return { dashboard: { title: dash.title, widgets: (dash.widgets as unknown[]).length }, applied: false };
    const mcp = await connectSigNoz();
    const created = await mcp.call<{ data?: { id?: string }; id?: string }>('create_dashboard', dash);
    await mcp.close();
    const id = created?.data?.id ?? created?.id;
    return { applied: true, createdId: id, webUrl: id ? `${process.env.SIGNOZ_URL ?? ''}/dashboard/${id}` : undefined };
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});

// Ask & Act is a stateful conversation: build ONE agent (with its checkpointer) + ONE MCP
// connection for the server's lifetime, and key memory by the client's threadId. Rebuilding per
// request — as before — reset the checkpointer every message, which is why the agent had amnesia.
// full SigNoz toolset — reads free, writes gated by interruptOn (the approval loop below)
let askActSingleton: ReturnType<typeof buildAskAct> | undefined;
async function getAskAct(): Promise<ReturnType<typeof buildAskAct>> {
  if (!askActSingleton) askActSingleton = buildAskAct(await connectSigNoz(), { readOnly: false });
  return askActSingleton;
}

/** pull the final ASSISTANT text out of the graph state (never a tool-result message) */
function lastText(state: unknown): { answer: string; turns: number } {
  type Msg = { content?: unknown; getType?: () => string; _getType?: () => string; type?: string; role?: string };
  const msgs = ((state as { messages?: Msg[] }).messages ?? []);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const kind = m.getType?.() ?? m._getType?.() ?? m.type ?? m.role;
    if (kind !== 'ai' && kind !== 'assistant') continue; // skip human / tool / system messages
    const c = m.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? '').join('') : '';
    if (text.trim()) return { answer: text, turns: msgs.length };
  }
  return { answer: '(no response)', turns: msgs.length };
}

type Pending = { tool: string; args: unknown; description?: string };
/** normalize HITL interrupt values (from the invoke return AND/OR the checkpoint snapshot) into
 * { tool, args } the UI can render. deepagents surfaces interrupts in either place by version. */
function extractPending(state: unknown, snapshot?: unknown): Pending[] {
  const values: unknown[] = [];
  for (const i of (state as { __interrupt__?: { value?: unknown }[] }).__interrupt__ ?? []) values.push(i.value);
  for (const t of (snapshot as { tasks?: { interrupts?: { value?: unknown }[] }[] })?.tasks ?? []) for (const it of t.interrupts ?? []) values.push(it.value);

  const out: Pending[] = [];
  const push = (name: unknown, args: unknown, description?: unknown) => {
    if (typeof name === 'string' && name) out.push({ tool: name, args, description: typeof description === 'string' ? description : undefined });
  };
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    // deepagents HITL shape: { actionRequests: [{ name, args, description? }] }
    const ars = (o.actionRequests ?? o.action_requests) as { name?: string; action?: string; args?: unknown; description?: string }[] | undefined;
    if (Array.isArray(ars)) ars.forEach((a) => push(a.name ?? a.action, a.args, a.description));
    // fallbacks: { action_request: { action, args } } or a bare { action, args }
    const ar = (o.action_request ?? o.actionRequest) as { action?: string; name?: string; args?: unknown } | undefined;
    if (ar) push(ar.action ?? ar.name, ar.args, o.description);
    else if (('args' in o || 'tool' in o) && typeof o.action === 'string') push(o.action, o.args, o.description);
    for (const val of Object.values(o)) { if (Array.isArray(val)) val.forEach(walk); else if (val && typeof val === 'object') walk(val); }
  };
  values.forEach(walk);
  // de-dupe (the walk can revisit nested copies)
  const seen = new Set<string>();
  return out.filter((p) => { const k = p.tool + JSON.stringify(p.args); if (seen.has(k)) return false; seen.add(k); return true; });
}

app.post('/api/ask', async (req, reply) => {
  try {
    const { question, threadId, approve } = (req.body ?? {}) as { question?: string; threadId?: string; approve?: boolean };
    const { agent, skills } = await getAskAct();
    const config = { configurable: { thread_id: threadId ?? 'default' }, recursionLimit: 120, callbacks: [ottoAgentTracer()] };
    const getSnap = () => (agent as unknown as { getState: (c: unknown) => Promise<unknown> }).getState(config);

    let input: unknown;
    if (approve !== undefined) {
      // resume: the HITL middleware wants { decisions: [...] } sized to the paused action requests
      const n = Math.max(1, extractPending({}, await getSnap()).length);
      const decision = approve ? { type: 'approve' } : { type: 'reject' };
      input = new Command({ resume: { decisions: Array.from({ length: n }, () => decision) } });
    } else {
      if (!question) throw new Error('provide { question }');
      input = { messages: [{ role: 'user', content: question }] };
    }

    const state = await agent.invoke(input as never, config as never);

    // the write gate: deepagents may report the paused write in the invoke result or the checkpoint
    let snapshot: unknown;
    try { snapshot = await (agent as unknown as { getState: (c: unknown) => Promise<unknown> }).getState(config); } catch { /* older api */ }
    const pending = extractPending(state, snapshot);
    if (pending.length) return { pending, threadId: threadId ?? 'default', skillsLoaded: skills.length };

    const answered = lastText(state);
    // if the graph paused (interrupt) but we couldn't parse the action, say so rather than "(no response)"
    const paused = !!(snapshot as { next?: unknown[] })?.next?.length;
    if (answered.answer === '(no response)' && paused) return { answer: 'I prepared a change that needs your approval, but I could not render the preview. Try rephrasing, or use the Migrate / SLO surface for dashboard authoring.', skillsLoaded: skills.length };
    return { ...answered, skillsLoaded: skills.length };
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});

// ---- SSE streaming variants: surface each step live instead of one long wait ----------
function sse(reply: import('fastify').FastifyReply): (e: unknown) => void {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  return (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
}

app.post('/api/migrate/stream', async (req, reply) => {
  const send = sse(reply);
  try {
    const b = req.body as { uid?: string; dashboard?: unknown; apply?: boolean };
    const dash = parseGrafanaDashboard((await resolveDashboard(b)) as never);
    send({ type: 'stage', stage: 'parse', status: 'done', note: `${dash.panels.length} query panels` });
    const mcp = await connectSigNoz();
    send({ type: 'stage', stage: 'readiness', status: 'start', note: 'auditing against live SigNoz' });
    const report = await runReadiness(dash, mcp);
    send({ type: 'stage', stage: 'readiness', status: 'done', note: `${report.summary.matched} matched · ${report.summary.renamed} renamed · ${report.summary.missing} missing` });
    const res = await fullMigrate(dash, report, mcp, { apply: !!b.apply, onEvent: send });
    await mcp.close();
    const webUrl = res.createdId ? `${process.env.SIGNOZ_URL ?? ''}/dashboard/${res.createdId}` : undefined;
    if (b.apply && res.createdId) recordRun({
      playbook: 'migration', title: dash.title, applied: true, webUrl,
      summary: `${res.included}/${dash.panels.length} panels migrated`,
      stats: { migrated: res.included, total: dash.panels.length, llmTokens: res.receipt.llm.inputTokens + res.receipt.llm.outputTokens, durationMs: res.receipt.durationMs },
    });
    send({ type: 'done', result: { title: dash.title, summary: { total: dash.panels.length, migrated: res.included }, outcomes: res.outcomes, receipt: res.receipt, createdId: res.createdId, webUrl } });
  } catch (e) { send({ type: 'error', error: (e as Error).message }); }
  finally { reply.raw.end(); }
});

app.post('/api/slo/stream', async (req, reply) => {
  const send = sse(reply);
  try {
    const b = req.body as { service?: string; operation?: string; timeRange?: string; apply?: boolean; channel?: string };
    if (!b.service || !b.operation) throw new Error('provide { service, operation }');
    const mcp = await connectSigNoz();
    send({ type: 'step', step: 'evidence', status: 'start', note: 'gathering traffic evidence' });
    const evidence = await analyzeSlo(mcp, b.service, b.operation, b.timeRange ?? '6h');
    send({ type: 'step', step: 'evidence', status: 'done', note: `${evidence.total} req · ${evidence.successPct.toFixed(1)}% ok · p95 ${(evidence.p95Ns / 1e6).toFixed(0)}ms` });
    send({ type: 'step', step: 'trend', status: 'start', note: 'checking latency trend' });
    const trend = await latencyTrend(mcp, b.service, b.operation);
    send({ type: 'step', step: 'trend', status: 'done', note: `latency ${trend.verdict}` });
    send({ type: 'step', step: 'propose', status: 'start', note: 'sizing the objective' });
    const proposal = await proposeSlo(mcp, evidence);
    send({ type: 'step', step: 'propose', status: 'done', note: `${proposal.objectivePct}% < ${proposal.latencyThresholdMs}ms / ${proposal.windowDays}d` });
    send({ type: 'step', step: 'reasoning', status: 'start', note: 'SRE analysis & alternatives' });
    const analysis = await analyzeSloReasoning(evidence, proposal, trend);
    send({ type: 'step', step: 'reasoning', status: 'done', note: `binding SLI: ${analysis.sliType}` });
    let applied: Awaited<ReturnType<typeof applySlo>> | undefined;
    if (b.apply) { send({ type: 'step', step: 'apply', status: 'start', note: 'creating dashboard + alert' }); applied = await applySlo(mcp, proposal, b.channel); send({ type: 'step', step: 'apply', status: 'done' }); }
    await mcp.close();
    const webUrl = applied?.dashboardId ? `${process.env.SIGNOZ_URL ?? ''}/dashboard/${applied.dashboardId}` : undefined;
    if (b.apply && applied?.dashboardId) recordRun({
      playbook: 'slo', title: `${b.service} · ${b.operation}`, applied: true, webUrl,
      summary: `SLO ${proposal.objectivePct}% < ${proposal.latencyThresholdMs}ms / ${proposal.windowDays}d${applied.alertCreated ? ' + alert' : ''}`,
      stats: { objectivePct: proposal.objectivePct, thresholdMs: proposal.latencyThresholdMs, successPct: Number(evidence.successPct.toFixed(2)) },
    });
    send({ type: 'done', result: { evidence, proposal, analysis, applied, webUrl } });
  } catch (e) { send({ type: 'error', error: (e as Error).message }); }
  finally { reply.raw.end(); }
});

const port = Number(process.env.PORT ?? 8010);
await app.listen({ port, host: '0.0.0.0' });
console.log(`Otto API listening on http://localhost:${port}`);
