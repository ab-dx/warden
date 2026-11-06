// loaded before the service with `node --import @warden/service-kit/telemetry` (NODE_OPTIONS in
// compose), so instrumentation is in place before anything it patches is imported. it does
// nothing unless an otlp endpoint is set, so tests and plain local runs are untouched.
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const metrics = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;

if (traces || metrics) {
  // esm imports are only patched through this loader hook
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { HttpInstrumentation },
    { ExpressInstrumentation },
    { UndiciInstrumentation },
    { PgInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-express'),
    import('@opentelemetry/instrumentation-undici'),
    import('@opentelemetry/instrumentation-pg'),
  ]);

  // the service's own package name ("@warden/edge-gateway" -> "edge-gateway"), so compose
  // needs no per-service setting
  const name = () => {
    try {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name?: string };
      return pkg.name?.replace(/^@warden\//, '');
    } catch {
      return undefined;
    }
  };

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? name() ?? 'warden',
    ...(traces ? { traceExporter: new OTLPTraceExporter() } : {}),
    ...(metrics
      ? {
          metricReaders: [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter(),
              exportIntervalMillis: 10_000,
            }),
          ],
        }
      : {}),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new UndiciInstrumentation(),
      new PgInstrumentation(),
    ],
  });
  // no sigterm handler: one would stop node exiting on its own, and losing the last few
  // seconds of spans on a stop is fine
  sdk.start();
}
