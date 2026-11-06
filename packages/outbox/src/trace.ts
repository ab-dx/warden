import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

// all of this is a no-op until a service starts the otel sdk

// the active trace as a w3c traceparent, so an event carries the request that caused it
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

// runs a kafka handler inside the trace its event was published from
export function consumed<T>(
  headers: Record<string, unknown> | undefined,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const carrier: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {}))
    if (v !== undefined && v !== null) carrier[k] = Buffer.isBuffer(v) ? v.toString() : String(v);
  const parent = propagation.extract(context.active(), carrier);
  return context.with(parent, () =>
    trace
      .getTracer('warden-outbox')
      .startActiveSpan(name, { kind: SpanKind.CONSUMER }, async (span) => {
        try {
          return await fn();
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      }),
  );
}
