// Full migration CLI (deterministic + agent). Migrates ALL query panels.
// Run: node ... full-migrate-cli.ts <dashboard.json> [--apply]
import { readFileSync } from 'node:fs';
import { initOtel, shutdownOtel } from '../otel/index.ts';
if (process.env.OTTO_OTEL) initOtel(); // self-instrument: export Otto's own run as a trace to SigNoz
import { parseGrafanaDashboard } from '../ingest/grafana.ts';
import { runReadiness } from '../readiness/index.ts';
import { fullMigrate } from '../engine/fullmigrate.ts';
import { connectSigNoz } from '../signoz/mcp.ts';

const pathArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const path = (pathArg ?? new URL('../../../samples/demo-dashboard.json', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const dash = parseGrafanaDashboard(JSON.parse(readFileSync(path, 'utf-8')));

const mcp = await connectSigNoz();
console.log(`\nFull-migrating "${dash.title}" — ${dash.panels.length} query panels + ${dash.structural.length} static\n`);
const report = await runReadiness(dash, mcp);
console.log(`Readiness: ${report.summary.matched} matched · ${report.summary.renamed} renamed · ${report.summary.missing} missing\n`);

const res = await fullMigrate(dash, report, mcp, { apply: process.argv.includes('--apply') });
await mcp.close();
await shutdownOtel(); // flush the last span/metric batch to SigNoz

const icon: Record<string, string> = { deterministic: '⚙️ ', agent: '🤖', none: '⛔' };
for (const o of res.outcomes) {
  console.log(`${icon[o.path]} ${o.status.padEnd(14)} ${o.title}${o.seriesCount ? `  (${o.seriesCount} series)` : ''}`);
  if (o.notes) console.log(`        ${o.notes.slice(0, 110)}`);
}
const det = res.outcomes.filter((o) => o.path === 'deterministic').length;
const ag = res.outcomes.filter((o) => o.path === 'agent').length;
const none = res.outcomes.filter((o) => o.path === 'none').length;
console.log(`\n${res.included}/${dash.panels.length} migrated  —  ⚙️  ${det} deterministic · 🤖 ${ag} agent · ⛔ ${none} needs-review`);
const r = res.receipt;
console.log(`Receipt: ${r.durationMs}ms · LLM ${r.llm.calls} calls (${r.llm.inputTokens}in/${r.llm.outputTokens}out tokens) · ${r.recovered.length} recovered`);
if (r.variables) {
  console.log(`Variables: ${r.variables.kept.length ? 'kept ' + r.variables.kept.join(', ') : 'none kept'}${r.variables.dropped.length ? ` · dropped ${r.variables.dropped.join(', ')} (free-text/unresolvable)` : ''}`);
}
if (res.createdId) console.log(`✅ Created dashboard ${res.createdId} in SigNoz.`);
else console.log('(dry run — pass --apply to create it)');

if (r.fidelity) {
  const f = r.fidelity;
  const ok = (b: boolean) => (b ? '✅' : '❌');
  console.log('\nReplication check (created vs original):');
  console.log(`  ${ok(f.titleMatch)} title matches original`);
  console.log(`  ${ok(f.tagsCarried)} original tags carried over`);
  console.log(`  ${ok(f.descriptionPresent)} description present`);
  console.log(`  ${ok(f.sectionsCreated >= f.sectionsExpected)} sections reproduced (${f.sectionsCreated}/${f.sectionsExpected})`);
  console.log(`  ${ok(f.panelsMigrated === f.panelsTotal)} panels migrated (${f.panelsMigrated}/${f.panelsTotal})`);
}
