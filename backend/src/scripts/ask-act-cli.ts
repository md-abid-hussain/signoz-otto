// Ask & Act CLI — converse with the SigNoz teammate.
//   npx tsx --env-file=.env src/scripts/ask-act-cli.ts "what's the p95 latency for checkout?"
//   add --act to allow writes (each write pauses for approval); --approve to auto-accept the pause.
import { initOtel, shutdownOtel } from '../otel/index.ts';
if (process.env.OTTO_OTEL) initOtel();
import { Command } from '@langchain/langgraph';
import { connectSigNoz } from '../signoz/mcp.ts';
import { buildAskAct } from '../agent/askact.ts';
import { ottoAgentTracer } from '../otel/index.ts';

const args = process.argv.slice(2);
const question = args.filter((a) => !a.startsWith('--')).join(' ') || 'Which services are emitting data, and which has the highest error rate in the last hour?';
const act = args.includes('--act');
const approve = args.includes('--approve');

const mcp = await connectSigNoz();
const { agent, skills, writeToolNames } = buildAskAct(mcp, { readOnly: !act });
console.log(`\nOtto (Ask & Act) — ${skills.length} SigNoz skills loaded · ${act ? 'ACT (writes gated)' : 'ASK (read-only)'}\n`);
console.log(`> ${question}\n`);

const config = { configurable: { thread_id: `askact-${Date.now()}` }, recursionLimit: 40, callbacks: [ottoAgentTracer()] };
const input = { messages: [{ role: 'user', content: question }] };

const lastText = (state: unknown): string => {
  const msgs = (state as { messages?: { content?: unknown; getType?: () => string }[] })?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i]!.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) { const t = c.map((p) => (p as { text?: string }).text ?? '').join(''); if (t.trim()) return t; }
  }
  return '(no text response)';
};

let result = await agent.invoke(input as never, config as never);

// handle a write-approval pause
const interrupts = (result as { __interrupt__?: { value?: unknown }[] }).__interrupt__;
if (interrupts?.length) {
  console.log('⏸  Otto wants to perform a gated action (write). Pending approval:');
  console.log(JSON.stringify(interrupts.map((i) => i.value), null, 2).slice(0, 800));
  if (approve) {
    console.log('\n✅ --approve given: resuming with accept...\n');
    result = await agent.invoke(new Command({ resume: [{ type: 'accept' }] }) as never, config as never);
  } else {
    console.log(`\n(gated: re-run with --approve to let Otto execute. Write tools: ${writeToolNames.join(', ')})`);
  }
}

console.log(lastText(result));
await mcp.close();
await shutdownOtel();
