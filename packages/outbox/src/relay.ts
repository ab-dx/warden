import type { Pool, PoolClient } from 'pg';
import { topicFor } from './topics.js';

export type OutboxMessage = {
  topic: string;
  key: string;
  value: Buffer;
  headers: Record<string, string>;
};

export interface Publisher {
  publish(messages: OutboxMessage[]): Promise<void>;
}

export type RelayOptions = {
  pool: Pool;
  publisher: Publisher;
  // one leader per service database; other replicas wait on this lock
  lockKey: number;
  batchSize?: number;
  pollMs?: number;
  onError?: (err: unknown) => void;
};

type Row = {
  seq: string;
  id: string;
  aggregatetype: string;
  aggregateid: string;
  type: string;
  payload: Buffer;
  traceparent: string | null;
};

export class OutboxRelay {
  private stopped = false;
  private wake: (() => void) | undefined;
  private lockClient: PoolClient | undefined;
  private loop: Promise<void> | undefined;

  constructor(private readonly opts: RelayOptions) {}

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  // publishes one batch in seq order. rows are only marked once kafka has
  // acked, so a crash in between means a duplicate, never a lost event.
  async drainOnce(): Promise<number> {
    const { pool, publisher, batchSize = 100 } = this.opts;
    const tx = await pool.connect();
    try {
      await tx.query('begin');
      const { rows } = await tx.query<Row>(
        `select seq, id, aggregatetype, aggregateid, type, payload, traceparent
         from outbox where published_at is null order by seq limit $1 for update`,
        [batchSize],
      );
      if (rows.length === 0) {
        await tx.query('commit');
        return 0;
      }
      await publisher.publish(
        rows.map((r) => ({
          topic: topicFor(r.aggregatetype),
          key: r.aggregateid,
          value: r.payload,
          headers: {
            'event-id': r.id,
            'event-type': r.type,
            ...(r.traceparent ? { traceparent: r.traceparent } : {}),
          },
        })),
      );
      await tx.query('update outbox set published_at = now() where seq = any($1::bigint[])', [
        rows.map((r) => r.seq),
      ]);
      await tx.query('commit');
      return rows.length;
    } catch (err) {
      await tx.query('rollback').catch(() => {});
      throw err;
    } finally {
      tx.release();
    }
  }

  private async run(): Promise<void> {
    const { lockKey, pollMs = 1000, onError } = this.opts;
    let backoff = 100;
    while (!this.stopped) {
      try {
        if (!this.lockClient) await this.becomeLeader();
        if (!this.lockClient) {
          await this.sleep(pollMs);
          continue;
        }
        const n = await this.drainOnce();
        backoff = 100;
        if (n === 0) await this.sleep(pollMs);
      } catch (err) {
        onError?.(err);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
    if (this.lockClient) {
      await this.lockClient.query('select pg_advisory_unlock($1)', [lockKey]).catch(() => {});
      this.lockClient.release();
      this.lockClient = undefined;
    }
  }

  private async becomeLeader(): Promise<void> {
    const client = await this.opts.pool.connect();
    const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
      this.opts.lockKey,
    ]);
    if (!rows[0]?.ok) {
      client.release();
      return;
    }
    // the session holding the lock also listens, so notifies wake the leader only
    client.on('notification', () => this.wake?.());
    // if the lock session dies, drop leadership and let someone else take it
    client.on('error', () => {
      this.lockClient = undefined;
    });
    await client.query('listen outbox');
    this.lockClient = client;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}
