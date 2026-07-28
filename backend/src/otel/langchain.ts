// OpenTelemetry tracing for LangChain / LangGraph / deepagents (the "otel the agents" piece).
// LangChain.js has no built-in OTLP exporter (that's Python-only), so we bridge its callback
// system to OTel spans: each chain / LLM / tool run becomes a span, nested by run-id, following
// the OTel GenAI semantic conventions (gen_ai.*). Attach via `callbacks: [ottoAgentTracer()]`.

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { trace, context, metrics, SpanStatusCode } from '@opentelemetry/api';
import type { Span, Context, Attributes } from '@opentelemetry/api';

const tracer = () => trace.getTracer('otto.agent');
// same instrument as engine/otel index → AgentOtto and migration both count into otto.llm.tokens
// (getMeter/createCounter are idempotent for a given name, so this shares the one counter).
const llmTokensCounter = () => metrics.getMeter('otto').createCounter('otto.llm.tokens', { description: 'LLM tokens consumed, by direction' });

type Serialized = { id?: string[] } | undefined;

export class OtelAgentTracer extends BaseCallbackHandler {
  name = 'otto-otel';
  // deepagents runs many concurrent tool calls; track each run's span + child context by run-id
  private runs = new Map<string, { span: Span; ctx: Context }>();
  private models = new Map<string, string>(); // runId → model, so handleLLMEnd can tag the token metric

  private begin(runId: string, parentRunId: string | undefined, name: string, attrs: Attributes): void {
    const parentCtx = (parentRunId && this.runs.get(parentRunId)?.ctx) || context.active();
    const span = tracer().startSpan(name, { attributes: attrs }, parentCtx);
    this.runs.set(runId, { span, ctx: trace.setSpan(parentCtx, span) });
  }
  private finish(runId: string, attrs?: Attributes, err?: Error): void {
    const r = this.runs.get(runId);
    if (!r) return;
    if (attrs) r.span.setAttributes(attrs);
    if (err) { r.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message }); r.span.recordException(err); }
    else r.span.setStatus({ code: SpanStatusCode.OK });
    r.span.end();
    this.runs.delete(runId);
  }
  private lastId = (s: Serialized) => (s?.id && s.id[s.id.length - 1]) || undefined;

  // ---- chains (incl. the graph nodes) ----
  handleChainStart(chain: Serialized, _inputs: unknown, runId: string, parentRunId?: string, _tags?: string[], _meta?: Record<string, unknown>, _runType?: string, runName?: string) {
    this.begin(runId, parentRunId, `chain.${runName ?? this.lastId(chain) ?? 'run'}`, { 'otto.kind': 'chain' });
  }
  handleChainEnd(_o: unknown, runId: string) { this.finish(runId); }
  handleChainError(err: Error, runId: string) { this.finish(runId, undefined, err); }

  // ---- LLM / chat model ----
  handleLLMStart(llm: Serialized, prompts: string[], runId: string, parentRunId?: string, _extra?: unknown, _tags?: string[], meta?: Record<string, unknown>, runName?: string) {
    this.beginLLM(llm, runId, parentRunId, meta, runName, prompts?.length ?? 0);
  }
  handleChatModelStart(llm: Serialized, messages: unknown[][], runId: string, parentRunId?: string, _extra?: unknown, _tags?: string[], meta?: Record<string, unknown>, runName?: string) {
    this.beginLLM(llm, runId, parentRunId, meta, runName, messages?.length ?? 0);
  }
  private beginLLM(llm: Serialized, runId: string, parentRunId: string | undefined, meta: Record<string, unknown> | undefined, runName: string | undefined, n: number) {
    const model = (meta?.ls_model_name as string) ?? runName ?? this.lastId(llm) ?? 'model';
    this.models.set(runId, model);
    this.begin(runId, parentRunId, 'llm.call', {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': (meta?.ls_provider as string) ?? 'openai',
      'gen_ai.request.model': model,
      'otto.prompt_count': n,
    });
  }
  handleLLMEnd(output: { llmOutput?: Record<string, unknown>; generations?: unknown }, runId: string) {
    const u = (output?.llmOutput?.tokenUsage ?? output?.llmOutput?.usage ?? output?.llmOutput?.estimatedTokenUsage) as Record<string, number> | undefined;
    const model = this.models.get(runId) ?? 'model';
    this.models.delete(runId);
    if (u) {
      const input = u.promptTokens ?? u.input_tokens ?? 0;
      const output_ = u.completionTokens ?? u.output_tokens ?? 0;
      // feed the shared token counter so AgentOtto usage shows up alongside migration usage
      llmTokensCounter().add(input, { direction: 'input', model });
      llmTokensCounter().add(output_, { direction: 'output', model });
    }
    this.finish(runId, u ? {
      'gen_ai.usage.input_tokens': u.promptTokens ?? u.input_tokens ?? 0,
      'gen_ai.usage.output_tokens': u.completionTokens ?? u.output_tokens ?? 0,
    } : undefined);
  }
  handleLLMError(err: Error, runId: string) { this.finish(runId, undefined, err); }

  // ---- tools (the SigNoz MCP calls the agent makes) ----
  handleToolStart(tool: Serialized, _input: string, runId: string, parentRunId?: string, _tags?: string[], _meta?: Record<string, unknown>, runName?: string) {
    const name = runName ?? this.lastId(tool) ?? 'tool';
    this.begin(runId, parentRunId, `tool.${name}`, { 'otto.kind': 'tool', 'otto.tool': name });
  }
  handleToolEnd(_o: unknown, runId: string) { this.finish(runId); }
  handleToolError(err: Error, runId: string) { this.finish(runId, undefined, err); }
}

/** one tracer instance per call site is fine; the handler is stateless across runs except its own map */
export function ottoAgentTracer(): OtelAgentTracer {
  return new OtelAgentTracer();
}
