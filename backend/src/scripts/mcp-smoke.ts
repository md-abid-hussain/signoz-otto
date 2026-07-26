// Smoke test: connect to signoz-mcp over HTTP, list tools, run a couple of read calls.
// Run: node --experimental-strip-types src/scripts/mcp-smoke.ts
import { connectSigNoz } from '../signoz/mcp.ts';

const mcp = await connectSigNoz();
console.log('connected. tools:', mcp.toolNames.length);
console.log('names:', mcp.toolNames.join(', '));
console.log('read tools resolved:', Object.keys(mcp.read).join(', '));
console.log('write tools resolved:', Object.keys(mcp.write).join(', '));

const metrics = await mcp.call('list_metrics', { searchText: 'calls', timeRange: '7d', limit: 5 });
console.log('\nlist_metrics(calls):', JSON.stringify(metrics).slice(0, 400));

await mcp.close();
console.log('\nOK');
