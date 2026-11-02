import type { Pool } from 'pg';
import { KafkaPublisher } from './kafka.js';
import { OutboxRelay } from './relay.js';
import { outboxSchemaSql } from './schema.js';

// creates the outbox tables and starts this service's relay to kafka
export async function startOutbox(opts: {
  pool: Pool;
  brokers: string[];
  clientId: string;
  lockKey: number;
  onError?: (err: unknown) => void;
}): Promise<{ stop: () => Promise<void> }> {
  await opts.pool.query(outboxSchemaSql);
  const publisher = await KafkaPublisher.connect(opts.brokers, opts.clientId);
  const relay = new OutboxRelay({
    pool: opts.pool,
    publisher,
    lockKey: opts.lockKey,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  relay.start();
  return {
    stop: async () => {
      await relay.stop();
      await publisher.close();
    },
  };
}
