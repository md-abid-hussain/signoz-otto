// Frontend RUM — instruments the Otto UI with OpenTelemetry and ships browser traces to the
// same SigNoz (service.name = otto-web). Page loads, clicks, and fetch calls become spans; the
// fetch instrumentation injects W3C traceparent into /api calls so the browser span links to the
// backend's server/engine spans → true end-to-end traces. Exports via the Vite /otlp proxy → :4318
// (avoids browser CORS against SigNoz's OTLP endpoint).

import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { UserInteractionInstrumentation } from '@opentelemetry/instrumentation-user-interaction';

export function initWebOtel(): void {
  try {
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'otto-web',
        [ATTR_SERVICE_VERSION]: '0.1.0',
      }),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: '/otlp/v1/traces' }))],
    });
    provider.register({ contextManager: new ZoneContextManager() });

    registerInstrumentations({
      instrumentations: [
        new DocumentLoadInstrumentation(),
        new UserInteractionInstrumentation(),
        new FetchInstrumentation({
          // link browser spans to the backend: propagate traceparent to our same-origin API
          propagateTraceHeaderCorsUrls: [/\/api\//],
          ignoreUrls: [/\/otlp\//], // don't trace the export calls themselves
        }),
      ],
    });
  } catch (e) {
    // RUM is best-effort; never block the app on telemetry setup
    console.warn('otto-web telemetry init failed', e);
  }
}
