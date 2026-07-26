// Surface 4 — Ask & Act: a conversational SigNoz teammate built on deepagents.
// It reasons over the live SigNoz MCP tools, follows the bundled SigNoz skills, and
// gates every write behind a human approval (interruptOn) — read freely, ask before acting.

import { createDeepAgent, listSkills } from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { SigNozMcp } from '../signoz/mcp.js';

/** minimal skill shape we use (deepagents ships two conflicting SkillMetadata types) */
interface SkillInfo { name: string; description: string; path: string }

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

ACTIONS (writes: create/update/delete dashboards, alerts, channels): when the user asks you to create or change something and you have the required details, CALL the write tool directly — the platform AUTOMATICALLY pauses every write and shows it to the user for approval before it executes, so you do NOT need to ask "reply approve" in text. Discover the real values first (services, metrics, fields) so the proposed write is correct. If a required detail is genuinely missing and undiscoverable, ask for just that. Never invent metric/service names.

create_alert gotchas (the tool's validator is stricter than the docs — get these right or it rejects the write):
- schemaVersion:"v2alpha1", version:"v5", ruleType:"threshold_rule".
- \`evaluation\` is TOP-LEVEL (sibling of condition), e.g. {kind:"rolling",spec:{evalWindow:"5m",frequency:"1m"}} — NOT inside condition.
- every thresholds.spec[] REQUIRES \`recoveryTarget\` (use null if no hysteresis) plus name/op/matchType/target.
- do NOT put \`order\` or \`limit\` on builder_query/builder_formula specs (they draw a 400).
- error-rate = two builder_query (A=errors filter has_error=true, B=total) both disabled:true + a builder_formula F1 "(A/B)*100"; selectedQueryName:"F1"; unit:"percent"; put the channel in thresholds.spec[].channels.
- a builder_query spec has: name, signal, stepInterval:60, aggregations, filter, disabled. A builder_formula spec has ONLY: name, expression, legend?, disabled? — NO stepInterval, NO aggregations, NO filter on the formula.
- op words: above/below/equal; matchType: at_least_once/all_the_times/on_average.

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

  // read tools always; write tools included unless readOnly, and always human-gated via interruptOn
  const writeTools = Object.values(mcp.write);
  const writeToolNames = writeTools.map((t) => t.name);
  const tools = opts.readOnly ? Object.values(mcp.read) : [...Object.values(mcp.read), ...writeTools];
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
