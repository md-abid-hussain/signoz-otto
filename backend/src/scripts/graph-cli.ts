// Run the migration as a LangGraph with the HITL interrupt.
// Demonstrates: run to pause-before-apply → inspect plan → approve → apply + verify.
// Run: node ... graph-cli.ts            (pauses, shows plan, does NOT write)
//      node ... graph-cli.ts --approve  (resumes past the interrupt → creates dashboard)
import { readFileSync } from 'node:fs';
import { buildMigrationGraph } from '../engine/graph.ts';
import { connectSigNoz } from '../signoz/mcp.ts';

const path = new URL('../../../samples/spanmetrics-dashboard.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const raw = JSON.parse(readFileSync(path, 'utf-8'));

const mcp = await connectSigNoz();
const graph = buildMigrationGraph(mcp);
const thread = { configurable: { thread_id: `run-${Date.now()}` } };

// 1) run until the interrupt before `apply`
await graph.invoke({ raw }, thread);
let snap = await graph.getState(thread);
const m = snap.values.migrations ?? [];
const a = snap.values.assembled;
console.log(`\n⏸  Paused before apply (HITL gate). Next node: ${snap.next.join(', ')}`);
console.log(`Plan: migrate ${a?.included} panels, skip ${a?.skipped.length}.`);
for (const p of m) console.log(`   ${p.status.padEnd(22)} ${p.title}`);

if (!process.argv.includes('--approve')) {
  console.log('\n(not approved — nothing written. Re-run with --approve to resume past the gate.)');
  await mcp.close();
  process.exit(0);
}

// 2) approve → resume from the checkpoint (null input continues past interruptBefore)
console.log('\n✔  Approved — resuming into apply…');
await graph.invoke(null, thread);
snap = await graph.getState(thread);
console.log(`✅ Created dashboard ${snap.values.createdId}  (verified: ${snap.values.verified})`);
await mcp.close();
