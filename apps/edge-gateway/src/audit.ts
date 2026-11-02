import { create } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { EventSchema } from '@warden/contracts';
import { enqueue } from '@warden/outbox';
import type pg from 'pg';
import type { Audit } from './mcp.js';

// every call is recorded before anything is forwarded
export function outboxAudit(pool: pg.Pool): Audit {
  return async ({ callId, intent, redactedArgs }) => {
    const event = create(EventSchema, {
      eventId: crypto.randomUUID(),
      occurredAt: timestampNow(),
      aggregateType: 'call',
      aggregateId: callId,
      producer: 'edge-gateway',
      payload: {
        case: 'callReceived',
        value: { intent, redactedArgsJson: JSON.stringify(redactedArgs) },
      },
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
  };
}
