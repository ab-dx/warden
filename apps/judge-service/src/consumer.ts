import { fromBinary } from '@bufbuild/protobuf';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { EventSchema } from '@warden/contracts';
import { consumed, handleOnce, topicFor } from '@warden/outbox';
import type pg from 'pg';
import { record } from './store.js';

export type Consumer = { stop: () => Promise<void> };

// builds the provenance index from what the gateway saw the agent read
export async function startConsumer(opts: {
  pool: pg.Pool;
  brokers: string[];
  groupId: string;
  onSkip: (reason: string) => void;
}): Promise<Consumer> {
  const kafka = new KafkaJS.Kafka({ kafkaJS: { brokers: opts.brokers, clientId: opts.groupId } });
  const consumer = kafka.consumer({ kafkaJS: { groupId: opts.groupId, fromBeginning: true } });
  await consumer.connect();
  await consumer.subscribe({ topics: [topicFor('untrusted-content')] });
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
      const p = event.payload;
      if (!event.eventId || p.case !== 'untrustedContentObserved')
        return opts.onSkip(`unexpected event at ${topic}/${partition}@${message.offset}`);
      const id = event.eventId;
      await consumed(message.headers, 'judge untrustedContentObserved', () =>
        handleOnce(opts.pool, opts.groupId, id, (tx) => record(tx, p.value)),
      );
    },
  });
  return { stop: () => consumer.disconnect() };
}
