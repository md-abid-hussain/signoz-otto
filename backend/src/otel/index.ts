// Otto's own OpenTelemetry instrumentation (DESIGN §7 "self-instrumentation").
// The tool that manages your observability is itself observable: every migration is a
// trace (otto.run → panel.migrate → llm.call), every LLM call carries token/cost metrics,
// and the Otto Ops dashboard renders it all in the same SigNoz instance Otto manages.
//
// Exports over OTLP/HTTP to SigNoz (:4318 by default). Enable by importing `initOtel()`
// before the pipeline runs (the CLIs do this when OTTO_OTEL=1). Zero-cost when disabled.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_SERVICE_NAMESPACE } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { trace, metrics, SpanStatusCode, context } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { Span, Attributes } from '@opentelemetry/api';

const SERVICE_NAME = process.env.OTTO_SERVICE_NAME ?? 'otto';
// group otto + otto-web under one application, and tag the environment — the two dimensions
// SigNoz filters services by out of the box (service.namespace / deployment.environment).
const SERVICE_NAMESPACE = process.env.OTTO_SERVICE_NAMESPACE ?? 'otto';
const DEPLOY_ENV = process.env.OTEL_DEPLOYMENT_ENV ?? process.env.NODE_ENV ?? 'demo';
// OTLP/HTTP endpoint; the exporter appends /v1/traces, /v1/metrics, /v1/logs.
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
      [ATTR_SERVICE_NAMESPACE]: SERVICE_NAMESPACE,
      'deployment.environment': DEPLOY_ENV,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${ENDPOINT}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${ENDPOINT}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
    // logs → SigNoz too, auto-correlated to the active span (trace_id/span_id stamped by the SDK)
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${ENDPOINT}/v1/logs` }) })],
    // inbound HTTP + Fastify routes (APM RED for the API itself) and outbound HTTP/undici
    // (LLM, MCP sidecar, Grafana). This module is imported first (see otel/bootstrap.ts) so the
    // instrumentation is registered before Fastify pulls in node:http.
    instrumentations: [new HttpInstrumentation(), new FastifyInstrumentation(), new UndiciInstrumentation()],
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

// ---- logs (OTel Logs API → SigNoz, correlated to the active trace) ------------------
const otoLogger = () => logs.getLogger('otto');

export function logInfo(body: string, attributes: Attributes = {}): void {
  otoLogger().emit({ severityNumber: SeverityNumber.INFO, severityText: 'INFO', body, attributes });
}

/** error log with OTel exception semconv attributes; pass the caught error for type/message/stack */
export function logError(body: string, err?: unknown, attributes: Attributes = {}): void {
  const ex = err instanceof Error ? { 'exception.type': err.name, 'exception.message': err.message, 'exception.stacktrace': err.stack ?? '' } : {};
  otoLogger().emit({ severityNumber: SeverityNumber.ERROR, severityText: 'ERROR', body, attributes: { ...attributes, ...ex } });
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
