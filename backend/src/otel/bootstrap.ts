// OTel bootstrap — MUST be the first import in server.ts. ESM evaluates imports in post-order,
// so importing this before Fastify guarantees the SDK (and its HTTP/Fastify instrumentation hooks)
// initialize before Fastify pulls in node:http → reliable inbound-request/APM spans. No-op unless
// OTTO_OTEL is set. Also captures process-level exceptions into OTel logs.

import { initOtel, logError, shutdownOtel } from './index.js';

if (process.env.OTTO_OTEL) {
  initOtel();

  // last-resort exception capture (per-request errors are handled by the Fastify onError hook).
  process.on('uncaughtException', (err) => {
    logError('uncaughtException', err);
    void shutdownOtel().finally(() => process.exit(1)); // preserve crash semantics, but flush first
  });
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  // flush telemetry on container stop (docker compose down / SIGTERM)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => { void shutdownOtel().finally(() => process.exit(0)); });
  }
}
