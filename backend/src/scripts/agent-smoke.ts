// Smoke-test the agent translator on one histogram-latency panel (deterministically unsupported).
import { readFileSync } from 'node:fs';
import { parseGrafanaDashboard } from '../ingest/grafana.ts';
import { runReadiness } from '../readiness/index.ts';
import { agentTranslatePanel } from '../agent/translate.ts';
import { connectSigNoz } from '../signoz/mcp.ts';

const raw = JSON.parse(readFileSync(new URL('../../../samples/spanmetrics-dashboard.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf-8'));
const dash = parseGrafanaDashboard(raw);
const mcp = await connectSigNoz();
const report = await runReadiness(dash, mcp);
const renames = new Map(report.metrics.filter((m) => m.mappedTo).map((m) => [m.name, m.mappedTo!]));
const avail = report.metrics.map((m) => m.mappedTo ?? m.name);

const panel = dash.panels.find((p) => /Service Latency/.test(p.title))!;
console.log(`Agent translating: "${panel.title}"`);
console.log(`Source PromQL: ${panel.targets[0]!.expr.slice(0, 120)}...`);
const r = await agentTranslatePanel(mcp, panel, renames, avail);
await mcp.close();
console.log('\nResult:', r.status, r.seriesCount ? `(${r.seriesCount} series)` : '');
console.log('Notes:', r.notes);
console.log('Queries:', JSON.stringify(r.queries, null, 2).slice(0, 700));
if (r.formula) console.log('Formula:', JSON.stringify(r.formula));
