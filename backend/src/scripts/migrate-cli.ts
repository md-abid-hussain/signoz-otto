// Migration dry-run CLI: parse → readiness → translate + validate (live), no writes.
// Run: node --experimental-strip-types src/scripts/migrate-cli.ts [dashboard.json]
import { readFileSync } from 'node:fs';
import { parseGrafanaDashboard } from '../ingest/grafana.ts';
import { runReadiness } from '../readiness/index.ts';
import { migrateDashboard, assembleDashboard, applyDashboard } from '../engine/migrate.ts';
import { connectSigNoz } from '../signoz/mcp.ts';

const pathArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const path = pathArg ?? new URL('../../../samples/spanmetrics-dashboard.json', import.meta.url).pathname;
const raw = JSON.parse(readFileSync(path.replace(/^\/([A-Za-z]:)/, '$1'), 'utf-8'));
const dash = parseGrafanaDashboard(raw);

const mcp = await connectSigNoz();
console.log(`\nMigrating "${dash.title}" — ${dash.panels.length} panels\n`);
const report = await runReadiness(dash, mcp);
console.log(`Readiness: ${report.summary.matched} matched · ${report.summary.renamed} renamed · ${report.summary.missing} missing\n`);

const results = await migrateDashboard(dash, report, mcp);

const icon = { validated: '✅', validated_with_renames: '🔄', needs_review: '⚠️', unsupported: '⛔' } as const;
const tally: Record<string, number> = {};
for (const p of results) {
  tally[p.status] = (tally[p.status] ?? 0) + 1;
  console.log(`${icon[p.status]} ${p.title}`);
  for (const t of p.targets) {
    const bits = [
      t.metricName ?? '(no metric)',
      t.seriesCount !== undefined ? `${t.seriesCount} series` : '',
      t.renames.length ? `renamed: ${t.renames.join(', ')}` : '',
      t.error ? `err: ${t.error}` : '',
    ].filter(Boolean).join('  |  ');
    console.log(`    [${t.refId}] ${icon[t.status]} ${bits}`);
  }
}
console.log('\nPanel tally:', Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(' · '));

// --apply gate (HITL stand-in for the CLI): only write when explicitly asked
if (process.argv.includes('--apply')) {
  const assembled = assembleDashboard(dash, results);
  console.log(`\nApplying: creating "${assembled.title}" with ${assembled.included} panels (skipped ${assembled.skipped.length})...`);
  const { id } = await applyDashboard(mcp, assembled);
  console.log(`✅ Created dashboard ${id ?? '(id unknown)'} in SigNoz.`);
} else {
  console.log('\n(dry run — pass --apply to create the dashboard in SigNoz)');
}
await mcp.close();
