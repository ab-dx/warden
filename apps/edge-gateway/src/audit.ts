import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { EventSchema } from '@warden/contracts';
import { enqueue } from '@warden/outbox';
import type pg from 'pg';
import type { Audit, Observe } from './mcp.js';

// every call is recorded before anything is forwarded
export function outboxAudit(pool: pg.Pool): Audit {
  return ({ callId, intent, redactedArgs }) =>
    write(pool, 'call', callId, {
      case: 'callReceived',
      value: { intent, redactedArgsJson: JSON.stringify(redactedArgs) },
    });
}

// what the agent read from an untrusted tool, keyed by session for provenance
export function outboxObserve(pool: pg.Pool): Observe {
  return ({ sessionId, sourceTool, sourceRef, tokens }) =>
    write(pool, 'session', sessionId, {
      case: 'untrustedContentObserved',
      value: { sessionId, sourceTool, sourceRef, tokens },
    });
}

async function write(
  pool: pg.Pool,
  aggregateType: string,
  aggregateId: string,
  payload: NonNullable<MessageInitShape<typeof EventSchema>['payload']>,
) {
  const event = create(EventSchema, {
    eventId: crypto.randomUUID(),
    occurredAt: timestampNow(),
    aggregateType,
    aggregateId,
    producer: 'edge-gateway',
    payload,
  });
  const tx = await pool.connect();
  try {
    await tx.query('begin');
    await enqueue(tx, event);
    await tx.query('commit');
  } catch (err) {
    await tx.query('rollback').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
