// LLM semantic metric matching — the readiness tail.
// The deterministic normalize heuristic only bridges dots↔underscores + unit/_total.
// Structural renames (otel_trace_span_processor_spans → otel.sdk.processor.span.processed)
// need semantic understanding. Given the "missing" Grafana metrics + the real SigNoz
// metric list, the LLM returns confident equivalents (or omits — never forces a match).

import { ChatOpenAI } from '@langchain/openai';

const SYSTEM = `You map Prometheus/Grafana metric names to their OpenTelemetry-renamed equivalents that actually exist in a SigNoz instance.

Input: "missing" = Grafana metric names not found by exact/normalised matching; "available" = real SigNoz metric names.
Return ONLY a JSON object mapping each Grafana name to the single best semantic-equivalent SigNoz name.

Rules:
- Only include a mapping when you are confident it is the SAME underlying measurement. Allow structural renames (e.g. otel_trace_span_processor_spans → otel.sdk.processor.span.processed; http_server_requests → http.server.request.count).
- OMIT a metric entirely if there is no clear equivalent. NEVER force a match. A wrong match is worse than "missing".
- The value MUST be one of the provided "available" names, verbatim.
- For histograms, map to the .bucket/.count/.sum family member that matches the source suffix if present.

Output: {"grafana_metric":"signoz.metric.name", ...} — or {} if none match.`;

function extractJson(text: string): Record<string, string> | null {
  const c = text.replace(/```json?/gi, '').replace(/```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(c.slice(s, e + 1)); } catch { return null; }
}

export interface MatchResult { matches: Record<string, string>; usage: { calls: number; inputTokens: number; outputTokens: number } }

export async function agentMatchMetrics(missing: string[], available: string[]): Promise<MatchResult> {
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  if (!missing.length || !process.env.OPENAI_API_KEY) return { matches: {}, usage };
  const llm = new ChatOpenAI({ model: process.env.LLM_MODEL ?? 'gpt-5.6-terra', apiKey: process.env.OPENAI_API_KEY });
  const resp = await llm.invoke([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ missing, available: available.slice(0, 250) }) },
  ] as never);
  const u = (resp as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
  usage.calls = 1; usage.inputTokens = u?.input_tokens ?? 0; usage.outputTokens = u?.output_tokens ?? 0;
  const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
  const raw = extractJson(content) ?? {};
  // guard against hallucination: keep only mappings whose target really exists and whose key was actually missing
  const availSet = new Set(available);
  const missSet = new Set(missing);
  const matches: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (missSet.has(k) && typeof v === 'string' && availSet.has(v)) matches[k] = v;
  }
  return { matches, usage };
}
