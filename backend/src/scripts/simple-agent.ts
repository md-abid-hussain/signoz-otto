// STANDALONE experiment (does not touch askact.ts): the minimal deepagents setup from the review —
// MCP tools + one read_resource tool + a MemorySaver checkpointer + a 2-turn memory test.
// Also A/B-tests the model config: responses-API (reasoning ON) vs the reasoning_effort:'none' hack.
//   run: npx tsx --env-file=.env src/scripts/simple-agent.ts
import { createDeepAgent } from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

const client = new MultiServerMCPClient({
  mcpServers: { signoz: { url: process.env.SIGNOZ_MCP_URL ?? 'http://localhost:8000/mcp', headers: { 'SIGNOZ-API-KEY': process.env.SIGNOZ_API_KEY! } } },
});

// semantic-safe truncation (per the review — never slice raw JSON blind)
const clip = (v: unknown, max = 16000): string => {
  const s = JSON.stringify(v);
  return s.length <= max ? s : s.slice(0, max) + '\n…(truncated, ask with narrower scope)';
};

const readSigNozResource = tool(
  async ({ uri }: { uri: string }) => clip(await client.readResource('signoz', uri)),
  { name: 'read_signoz_resource', description: 'Read a SigNoz MCP resource by URI (discover URIs via signoz_list_resources).', schema: z.object({ uri: z.string() }) },
);

const tools = [...(await client.getTools()), readSigNozResource];
console.log('MCP tools loaded:', tools.length);

const lastText = (s: unknown): string => {
  const m = (s as { messages?: { content?: unknown; getType?: () => string }[] }).messages ?? [];
  for (let i = m.length - 1; i >= 0; i--) {
    if (m[i]!.getType?.() !== 'ai') continue;
    const c = m[i]!.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) { const t = c.map((p) => (p as { text?: string }).text ?? '').join(''); if (t.trim()) return t; }
  }
  return '(no text)';
};

function mkModel(useResponses: boolean): ChatOpenAI {
  const base = { model: process.env.LLM_MODEL ?? 'gpt-5.6-terra', apiKey: process.env.OPENAI_API_KEY };
  return new ChatOpenAI(useResponses
    ? ({ ...base, useResponsesApi: true } as never)          // reasoning stays ON
    : ({ ...base, modelKwargs: { reasoning_effort: 'none' } } as never)); // the current hack
}

for (const useResponses of [true, false]) {
  console.log(`\n=== ${useResponses ? 'useResponsesApi (reasoning ON)' : 'reasoning_effort:none (reasoning OFF)'} ===`);
  try {
    const agent = createDeepAgent({ model: mkModel(useResponses), tools, checkpointer: new MemorySaver() });
    const cfg = { configurable: { thread_id: `t-${useResponses}` }, recursionLimit: 30 };
    const r1 = await agent.invoke({ messages: [{ role: 'user', content: 'How many services are reporting to SigNoz right now? Reply with just the number and remember it.' }] } as never, cfg as never);
    console.log('turn1:', lastText(r1).slice(0, 140));
    const r2 = await agent.invoke({ messages: [{ role: 'user', content: 'What number did you just give me? One line.' }] } as never, cfg as never);
    console.log('turn2 (memory):', lastText(r2).slice(0, 140));
  } catch (e) {
    console.log('FAILED:', (e as Error).message.slice(0, 200));
  }
}
await client.close();
