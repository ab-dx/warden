import { fromBinary } from '@bufbuild/protobuf';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { EventSchema } from '@warden/contracts';
import { handleOnce, topicFor } from '@warden/outbox';
import type pg from 'pg';
import { append } from './store.js';

export const TOPICS = ['calls', 'decisions', 'approvals', 'payments', 'untrusted-content'].map(
  topicFor,
);

export type Consumer = { stop: () => Promise<void> };

// reads every event topic into the ledger. offsets are committed only after the row is
// written, and the inbox drops redeliveries, so each event lands exactly once.
export async function startConsumer(opts: {
  pool: pg.Pool;
  brokers: string[];
  groupId: string;
  onSkip: (reason: string) => void;
}): Promise<Consumer> {
  const kafka = new KafkaJS.Kafka({ kafkaJS: { brokers: opts.brokers, clientId: opts.groupId } });
  const consumer = kafka.consumer({ kafkaJS: { groupId: opts.groupId, fromBeginning: true } });
  await consumer.connect();
  await consumer.subscribe({ topics: TOPICS });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let event: ReturnType<typeof fromBinary<typeof EventSchema>>;
      try {
        event = fromBinary(EventSchema, message.value as Buffer);
      } catch {
        // shortcut: unreadable messages are skipped and logged; send them to warden.dlq.v1 once there is a consumer for it
        opts.onSkip(`undecodable message at ${topic}/${partition}@${message.offset}`);
        return;
      }
      if (!event.eventId)
        return opts.onSkip(`event without id at ${topic}/${partition}@${message.offset}`);
      await handleOnce(opts.pool, opts.groupId, event.eventId, (tx) => append(tx, event));
    },
  });
  return { stop: () => consumer.disconnect() };
}
