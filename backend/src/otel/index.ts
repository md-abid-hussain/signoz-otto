// Otto's own OpenTelemetry instrumentation (DESIGN §7 "self-instrumentation").
// The tool that manages your observability is itself observable: every migration is a
// trace (otto.run → panel.migrate → llm.call), every LLM call carries token/cost metrics,
// and the Otto Ops dashboard renders it all in the same SigNoz instance Otto manages.
//
// Exports over OTLP/HTTP to SigNoz (:4318 by default). Enable by importing `initOtel()`
// before the pipeline runs (the CLIs do this when OTTO_OTEL=1). Zero-cost when disabled.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { trace, metrics, SpanStatusCode, context } from '@opentelemetry/api';
import type { Span, Attributes } from '@opentelemetry/api';

const SERVICE_NAME = process.env.OTTO_SERVICE_NAME ?? 'otto';
// OTLP/HTTP endpoint; the exporter appends /v1/traces and /v1/metrics.
const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

let sdk: NodeSDK | undefined;
let started = false;

/** Start the OTel SDK. Idempotent; safe to call from any CLI entrypoint. */
export function initOtel(): void {
  if (started) return;
  started = true;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${ENDPOINT}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${ENDPOINT}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
    // auto-instrument outbound HTTP: LLM (OpenAI), the MCP sidecar, and Grafana all become spans
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
  });
  sdk.start();
}

/** Flush and shut down — call before process exit so the last batch is exported. */
export async function shutdownOtel(): Promise<void> {
  if (sdk) { try { await sdk.shutdown(); } catch { /* best-effort flush */ } }
}

// ---- instruments (created lazily so they no-op cleanly when OTel is disabled) --------

const tracer = () => trace.getTracer('otto');
const meter = () => metrics.getMeter('otto');

const panelsCounter = () => meter().createCounter('otto.panels', { description: 'panels processed, by migration status' });
const llmTokens = () => meter().createCounter('otto.llm.tokens', { description: 'LLM tokens consumed, by direction' });
const llmCost = () => meter().createCounter('otto.llm.cost_usd', { description: 'estimated LLM spend (USD)' });
const runDuration = () => meter().createHistogram('otto.run.duration', { description: 'end-to-end run duration', unit: 'ms' });

// ---- recording helpers (used by the engine) -----------------------------------------

export function recordPanel(status: string, path: string): void {
  panelsCounter().add(1, { status, path });
}

const COST_IN = Number(process.env.LLM_COST_PER_1K_IN ?? 0);
const COST_OUT = Number(process.env.LLM_COST_PER_1K_OUT ?? 0);

export function recordLlm(inputTokens: number, outputTokens: number, model: string): number {
  llmTokens().add(inputTokens, { direction: 'input', model });
  llmTokens().add(outputTokens, { direction: 'output', model });
  const cost = (inputTokens / 1000) * COST_IN + (outputTokens / 1000) * COST_OUT;
  if (cost > 0) llmCost().add(cost, { model });
  return cost;
}

export function recordRunDuration(ms: number, playbook: string, status: string): void {
  runDuration().record(ms, { playbook, status });
}

/** Run `fn` inside a span, recording exceptions and status. Returns fn's result. */
export async function withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T> | T): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      span.recordException(e as Error);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Add attributes to the currently-active span (e.g. final status once known). */
export function annotateSpan(attrs: Attributes): void {
  trace.getSpan(context.active())?.setAttributes(attrs);
}

export { ottoAgentTracer, OtelAgentTracer } from './langchain.js';
