// Readiness CLI: parse a Grafana dashboard → resolve metrics against live SigNoz → print the ✅/🔄/❌ report.
// Run: node --experimental-strip-types src/scripts/readiness-cli.ts [path-to-dashboard.json]
import { readFileSync } from 'node:fs';
import { parseGrafanaDashboard } from '../ingest/grafana.ts';
import { runReadiness } from '../readiness/index.ts';
import { connectSigNoz } from '../signoz/mcp.ts';

const path = process.argv[2] ?? new URL('../../../samples/spanmetrics-dashboard.json', import.meta.url).pathname;
const raw = JSON.parse(readFileSync(path.replace(/^\/([A-Za-z]:)/, '$1'), 'utf-8'));

const dash = parseGrafanaDashboard(raw);
console.log(`\nDashboard: "${dash.title}" — ${dash.panels.length} query panels, ${dash.structural.length} structural, ${dash.variables.length} variables`);
console.log(`Dependencies: ${dash.dependencies.metrics.length} metrics, ${dash.dependencies.labels.length} labels\n`);

const mcp = await connectSigNoz();
const report = await runReadiness(dash, mcp);
await mcp.close();

const icon = { matched: '✅', renamed: '🔄', missing: '❌' } as const;
console.log('READINESS REPORT');
for (const m of report.metrics) {
  const to = m.mappedTo ? ` → ${m.mappedTo}` : '';
  console.log(`  ${icon[m.verdict]} ${m.name}${to}   [panels: ${m.panelsAffected.join(', ') || '-'}]`);
}
console.log(`\nSummary: ${report.summary.matched} matched · ${report.summary.renamed} renamed · ${report.summary.missing} missing`);
console.log('\nPer-panel prediction:');
for (const p of dash.panels) console.log(`  ${report.perPanelPrediction[p.id]}  —  ${p.title}`);
