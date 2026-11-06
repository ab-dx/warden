import { context, propagation, ROOT_CONTEXT, TraceFlags, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumed, currentTraceparent } from './trace.js';

const TRACE = '0af7651916cd43dd8448eb211c80319c';

describe('trace across kafka', () => {
  // what the sdk installs in a running service
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });
  afterAll(() => {
    propagation.disable();
    context.disable();
  });

  it('carries the producer trace into the consumer', async () => {
    const producing = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE,
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    });
    const traceparent = context.with(producing, currentTraceparent);
    expect(traceparent).toBe(`00-${TRACE}-b7ad6b7169203331-01`);

    // kafka hands headers over as buffers
    const seen = await consumed(
      { traceparent: Buffer.from(traceparent ?? '') },
      'handle',
      async () => trace.getSpanContext(context.active())?.traceId,
    );
    expect(seen).toBe(TRACE);
  });

  it('has nothing to carry outside a trace', () => {
    expect(currentTraceparent()).toBeUndefined();
  });
});
