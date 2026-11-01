import { toBinary } from '@bufbuild/protobuf';
import { type Event, EventSchema } from '@warden/contracts';
import type { ClientBase } from 'pg';
import { topicStem } from './topics.js';

// must run on the same client, inside the same transaction, as the state change
// it describes. that is the whole point of the outbox.
export async function enqueue(tx: ClientBase, event: Event, traceparent?: string): Promise<void> {
  const kind = event.payload.case;
  if (!kind) throw new Error(`event ${event.eventId} has no payload`);
  if (!event.eventId || !event.aggregateId) throw new Error('event needs eventId and aggregateId');
  await tx.query(
    `insert into outbox (id, aggregatetype, aggregateid, type, payload, traceparent)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      event.eventId,
      topicStem[kind],
      event.aggregateId,
      kind,
      Buffer.from(toBinary(EventSchema, event)),
      traceparent ?? null,
    ],
  );
}
