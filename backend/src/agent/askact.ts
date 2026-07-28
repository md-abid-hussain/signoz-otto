// Surface 4 — Ask & Act: a conversational SigNoz teammate built on deepagents.
// It reasons over the live SigNoz MCP tools, follows the bundled SigNoz skills, and
// gates every write behind a human approval (interruptOn) — read freely, ask before acting.

import { createDeepAgent, listSkills } from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { SigNozMcp } from '../signoz/mcp.js';

/** minimal skill shape we use (deepagents ships two conflicting SkillMetadata types) */
interface SkillInfo { name: string; description: string; path: string }

/** MCP has three component types; LLM agents can only call tools, so resources and prompts are
 * bridged 1:1 here. Nothing is hand-written about SigNoz itself — the agent reads the server's own
 * canonical docs at runtime. (Tools need no bridge: all of them are passed through as-is.) */
function mcpSurfaceTools(mcp: SigNozMcp) {
  // truncate with an explicit marker so the agent knows the doc was cut and can narrow — never
  // hand back silently-sliced (broken) JSON it might try to complete from imagination.
  const clip = (v: unknown, n: number) => { const s = JSON.stringify(v); return s.length <= n ? s : s.slice(0, n) + '\n…(truncated — read a more specific resource)'; };
  return [
    tool(async () => clip(await mcp.listResources(), 8000), {
      name: 'signoz_list_resources',
      description: 'List every SigNoz MCP resource (canonical signoz://… docs: schemas, instructions, examples). Call this FIRST to discover the exact URIs available on this server, then read the relevant one.',
      schema: z.object({}),
    }),
    tool(async ({ uri }) => clip(await mcp.readResource(uri), 24000), {
      name: 'signoz_read_resource',
      description: 'Read a SigNoz MCP resource by its exact URI (get URIs from signoz_list_resources). This is the source of truth for payload schemas and examples.',
      schema: z.object({ uri: z.string().describe('exact resource URI from signoz_list_resources') }),
    }),
    tool(async () => clip(await mcp.listPrompts(), 4000), {
      name: 'signoz_list_prompts',
      description: 'List SigNoz MCP prompts, if the server serves any.',
      schema: z.object({}),
    }),
    tool(async ({ name }) => clip(await mcp.getPrompt(name), 8000), {
      name: 'signoz_get_prompt',
      description: 'Get a SigNoz MCP prompt by name.',
      schema: z.object({ name: z.string() }),
    }),
  ];
}

/** repo-root/signoz-skill — the 13 SigNoz agent skills the teammate follows */
function skillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // backend/src/agent
  return resolve(here, '../../../signoz-skill');
}

/** Distil the SigNoz skills into an operating prompt + a catalog of the playbooks available. */
function systemPrompt(skills: SkillInfo[]): string {
  const catalog = skills.length
    ? skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim().slice(0, 180)}`).join('\n')
    : '(no skill catalog loaded)';
  return `You are Otto, an observability teammate operating a self-hosted SigNoz through its MCP tools, following the SigNoz skills.

Core rules:
- DISCOVERY FIRST — never guess metric, field, or service names. Confirm with list_metrics / list_services / get_field_keys / get_field_values before you filter or group. Prefer resource attributes (service.name, k8s.namespace.name, host.name) in filters — they're fastest.
- Match the aggregation to the data: counters → rate/increase, gauges → avg/latest (never rate a gauge); trace percentiles use p95(duration_nano), counts use count(). Pick the signal deliberately (metrics for rates/latency, traces for per-request detail, logs for text/severity); if ambiguous, ask.
- Report OBSERVATIONS with timestamps and values ("error rate rose 0.2%→4.1% at 14:05"), never root cause. One focused query per question; present no-data honestly.

Writes (create/update/delete dashboards, alerts, channels):
- The platform pauses every write for the user's approval automatically — so CALL the write tool. Do NOT ask "reply approve", and do NOT just say "I'll create it": the approval fires only on the EMITTED tool call, so narrating without emitting does nothing.
- Get the payload schema from the server, never memory: signoz_list_resources → signoz_read_resource(uri) (also signoz_search_docs / signoz_list_dashboard_templates). Never invent field names, and never refuse for lack of a schema — read the resource.
- UPDATES are full replacements: GET the current object, modify it, send the WHOLE object back.

Self-correct: a TOOL_ERROR is recoverable. Read it (validation errors name the field + allowed values), fix the payload, and emit the corrected call immediately in the same turn — up to ~5 tries. Never report a validation error and stop.

Available SigNoz playbooks:
${catalog}

Answer concisely — show the numbers and the time range, and offer a useful next drill-down.`;
}

export interface AskActAgent {
  agent: ReturnType<typeof createDeepAgent>;
  skills: SkillInfo[];
  writeToolNames: string[];
}

/** Build the Ask & Act deep agent over the given SigNoz MCP connection. */
export function buildAskAct(mcp: SigNozMcp, opts: { readOnly?: boolean } = {}): AskActAgent {
  const skills = safeListSkills();
  // gpt-5.6-terra rejects function tools on /v1/chat/completions unless reasoning is off — but the
  // /v1/responses API supports tools WITH reasoning on. Use it so the agent can actually reason
  // (choose signals, self-correct on validation errors) instead of being lobotomized. Verified in
  // scripts/simple-agent.ts: responses-API + tools + multi-turn memory all work.
  const model = new ChatOpenAI({ model: process.env.LLM_MODEL ?? 'gpt-5.6-terra', apiKey: process.env.OPENAI_API_KEY, useResponsesApi: true } as never);

  // THE COMPLETE MCP SURFACE: every tool the server exposes (not a curated subset — that's what
  // starved the agent of signoz_search_docs / fetch_doc / list_dashboard_templates), plus resources
  // and prompts bridged as tools. The engine keeps its own curated read/write maps; the agent gets everything.
  // Give the agent the FULL MCP surface, every tool with its real schema. Writes are gated by
  // interruptOn (below); read-only mode simply drops the write tools.
  // Gate anything that isn't a known read verb (robust to write verbs beyond create/update/delete —
  // e.g. mute/pause/reset/apply — so a new write tool can't slip through ungated).
  const READ_VERBS = new Set(['get', 'list', 'search', 'fetch', 'read', 'describe', 'explain', 'query', 'aggregate', 'execute', 'check']);
  const isWrite = (n: string) => !READ_VERBS.has(n.replace(/^signoz_/, '').split('_')[0]!);
  const allTools = mcp.raw; // real schemas, plain — let the framework handle tool errors as observations
  const writeToolNames = allTools.map((t) => t.name).filter(isWrite);
  const tools = [...(opts.readOnly ? allTools.filter((t) => !isWrite(t.name)) : allTools), ...mcpSurfaceTools(mcp)];
  const interruptOn: Record<string, boolean> = {};
  if (!opts.readOnly) for (const n of writeToolNames) interruptOn[n] = true; // pause before every write

  const gated = Object.keys(interruptOn).length > 0;
  const agent = createDeepAgent({
    model,
    tools,
    systemPrompt: systemPrompt(skills),
    // ALWAYS checkpoint: this is what gives the agent cross-turn memory. With a stable thread_id,
    // each invoke() loads the thread's prior messages and appends the new one (add_messages reducer),
    // so it's a real multi-turn conversation — not a fresh single pass each message. The same
    // checkpointer instance must live across requests, so the caller caches this agent as a singleton.
    checkpointer: new MemorySaver(),
    ...(gated ? { interruptOn } : {}),
  });

  return { agent, skills, writeToolNames };
}

function safeListSkills(): SkillInfo[] {
  try { return listSkills({ projectSkillsDir: skillsDir() }); }
  catch { return []; }
}
