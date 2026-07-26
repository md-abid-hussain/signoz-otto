// SLO copilot CLI: analyze traffic → propose an evidence-based SLO → (optionally) apply.
// Run: node ... slo-cli.ts <service> <operation> [--apply --channel <name>]
import { analyzeSlo, proposeSlo, applySlo } from '../engine/slo.ts';
import { connectSigNoz } from '../signoz/mcp.ts';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const service = positional[0] ?? 'checkout';
const operation = positional[1] ?? 'oteldemo.CheckoutService/PlaceOrder';
const channelIdx = args.indexOf('--channel');
const channel = channelIdx >= 0 ? args[channelIdx + 1] : undefined;

const mcp = await connectSigNoz();
console.log(`\nAnalyzing SLO candidate: ${service} / ${operation}\n`);
const ev = await analyzeSlo(mcp, service, operation, '6h');
console.log(`Evidence (${ev.windowLabel}): ${ev.total} reqs · ${ev.errors} errors · ${ev.successPct.toFixed(2)}% success`);
console.log(`  p50 ${(ev.p50Ns / 1e6).toFixed(0)}ms · p95 ${(ev.p95Ns / 1e6).toFixed(0)}ms · p99 ${(ev.p99Ns / 1e6).toFixed(0)}ms`);

const p = await proposeSlo(mcp, ev);
console.log(`\nProposed SLO: ${p.objectivePct}% of ${operation} succeed AND < ${p.latencyThresholdMs}ms over ${p.windowDays}d`);
console.log(`Reasoning: ${p.reasoning}`);

if (args.includes('--apply')) {
  console.log(`\nApplying (dashboard${channel ? ' + alert → ' + channel : ', no alert (pass --channel)'} )...`);
  const r = await applySlo(mcp, p, channel);
  console.log(`✅ SLO dashboard ${r.dashboardId}${r.alertCreated ? ' + alert created' : ''}`);
} else {
  console.log('\n(dry run — pass --apply [--channel <name>] to create the SLO dashboard + alert)');
}
await mcp.close();
