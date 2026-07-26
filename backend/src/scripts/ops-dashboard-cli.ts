// Create the Otto Ops self-observability dashboard in SigNoz.
// Run: npx tsx --env-file=.env src/scripts/ops-dashboard-cli.ts [--apply]
import { buildOttoOpsDashboard } from '../engine/opsdash.ts';
import { connectSigNoz } from '../signoz/mcp.ts';

const dash = buildOttoOpsDashboard();
if (!process.argv.includes('--apply')) {
  console.log('Otto Ops dashboard (dry run — pass --apply to create):');
  console.log(`  ${(dash.widgets as unknown[]).length} widgets · tags ${(dash.tags as string[]).join(', ')}`);
  process.exit(0);
}

const mcp = await connectSigNoz();
const created = await mcp.call<{ data?: { id?: string }; id?: string }>('create_dashboard', dash);
const id = created?.data?.id ?? created?.id;
await mcp.close();
console.log(id ? `✅ Created Otto Ops dashboard ${id}` : `⚠️ Created but no id returned: ${JSON.stringify(created).slice(0, 200)}`);
