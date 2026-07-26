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

/** MCP tool errors THROW, which kills the whole turn — the model never sees the failure and can't
 * fix it. Return them as observations instead so the agent can read the validation message, correct
 * the payload, and retry (the standard tool-error → observation pattern). Generic: no SigNoz knowledge. */
function faultTolerant(t: StructuredToolInterface): StructuredToolInterface {
  return tool(
    async (input: unknown) => {
      try {
        return await t.invoke(input as never);
      } catch (e) {
        return `TOOL_ERROR from ${t.name}: ${(e as Error).message}\nRead this error, correct the payload, and call the tool again. Do not give up after one failure.`;
      }
    },
    { name: t.name, description: t.description, schema: t.schema as never },
  ) as unknown as StructuredToolInterface;
}

/** MCP has three component types; LLM agents can only call tools, so resources and prompts are
 * bridged 1:1 here. Nothing is hand-written about SigNoz itself — the agent reads the server's own
 * canonical docs at runtime. (Tools need no bridge: all of them are passed through as-is.) */
function mcpSurfaceTools(mcp: SigNozMcp) {
  const clip = (v: unknown, n: number) => JSON.stringify(v).slice(0, n);
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
  return `You are Otto, an observability teammate operating a self-hosted SigNoz instance through its MCP tools.

Operating rules (from the SigNoz skills — follow them):
- DISCOVERY FIRST. Never guess metric, field, or service names. Confirm with list_metrics / list_services / get_field_keys / get_field_values before filtering or grouping. A field is real only if a tool returned it.
- PREFER RESOURCE ATTRIBUTES in filters (service.name, k8s.namespace.name, host.name) — they query fastest. If the user gives no scope, discover candidates and ask which to use.
- CHOOSE THE SIGNAL deliberately: metrics for rates/latency/throughput (fastest, pre-aggregated), traces for per-request detail, logs for text/severity. If ambiguous, ask.
- timeAggregation must match metric type: counters → rate/increase; gauges → avg/latest (never rate a gauge). Percentiles from traces use p95(duration_nano); counts use the expression count().
- NEVER CLAIM ROOT CAUSE. Report observations with timestamps and values ("error rate rose from 0.2% to 4.1% at 14:05"), not causation.
- One focused query per question. Use parallel discovery, precise execution. Present no-data honestly (healthy-zero vs out-of-range vs missing instrumentation).

ACTIONS (writes: create/update/delete dashboards, alerts, channels): when the user asks you to create or change something — DISCOVER the real values (services, operations, metrics, fields), READ the canonical schema from the MCP resource, author the payload, and CALL the write tool. The platform AUTOMATICALLY pauses every write for the user's approval before it executes, so do NOT ask "reply approve" in text, and NEVER refuse a write for lack of a schema — read the resource instead. Never invent metric/service names.

Get schemas from the server, never from memory. Before authoring any create/update payload:
1. signoz_list_resources → see the exact resource URIs THIS server serves (do not assume a URI exists; some referenced in guides are absent).
2. signoz_read_resource(uri) → the canonical schema + working examples. This is the source of truth.
3. signoz_search_docs / signoz_fetch_doc → the official docs for anything else; signoz_list_dashboard_templates → real dashboard JSON you can model a new one on.

SELF-CORRECT ON FAILURE. A tool result starting with TOOL_ERROR is a recoverable failure, not a dead end. Read the message — validation errors name the offending field and its allowed values — fix exactly that and call the tool again. If the message is vague, re-read the relevant MCP resource and compare your payload to its example field by field. Try up to 3 corrections before telling the user you are stuck. Never report a validation error and stop.

Available SigNoz playbooks (invoke the matching approach when the task fits):
${catalog}

Answer concisely. Show the numbers and the time range. Offer a next drill-down when useful.`;
}

export interface AskActAgent {
  agent: ReturnType<typeof createDeepAgent>;
  skills: SkillInfo[];
  writeToolNames: string[];
}

/** Build the Ask & Act deep agent over the given SigNoz MCP connection. */
export function buildAskAct(mcp: SigNozMcp, opts: { readOnly?: boolean } = {}): AskActAgent {
  const skills = safeListSkills();
  // gpt-5.6-terra rejects function tools unless reasoning_effort is 'none' on /v1/chat/completions
  const model = new ChatOpenAI({ model: process.env.LLM_MODEL ?? 'gpt-5.6-terra', apiKey: process.env.OPENAI_API_KEY, modelKwargs: { reasoning_effort: 'none' } });

  // THE COMPLETE MCP SURFACE: every tool the server exposes (not a curated subset — that's what
  // starved the agent of signoz_search_docs / fetch_doc / list_dashboard_templates), plus resources
  // and prompts bridged as tools. The engine keeps its own curated read/write maps; the agent gets everything.
  const isWrite = (n: string) => /(^|_)(create|update|delete|import)_/.test(n);
  const allTools = mcp.raw.map(faultTolerant); // failures come back as observations, not thrown
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
