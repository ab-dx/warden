import { createServer } from 'node:net';
import { create, fromBinary } from '@bufbuild/protobuf';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type Event, EventSchema, Outcome } from '@warden/contracts';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  enqueue,
  handleOnce,
  KafkaPublisher,
  OutboxRelay,
  outboxSchemaSql,
  type Publisher,
} from './index.js';

let pgc: StartedPostgreSqlContainer;
let kafkac: StartedTestContainer;
let pool: pg.Pool;
let brokers: string[];
let publisher: KafkaPublisher;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const decision = (callId: string, eventId = crypto.randomUUID()): Event =>
  create(EventSchema, {
    eventId,
    aggregateType: 'call',
    aggregateId: callId,
    producer: 'test',
    payload: { case: 'decisionMade', value: { callId, outcome: Outcome.ALLOW } },
  });

async function inTx(fn: (c: pg.PoolClient) => Promise<void>, commit = true) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await fn(c);
    await c.query(commit ? 'commit' : 'rollback');
  } finally {
    c.release();
  }
}

async function readTopic(topic: string, expected: number, timeoutMs = 20_000) {
  const kafka = new KafkaJS.Kafka({ kafkaJS: { brokers, clientId: 'test-reader' } });
  const consumer = kafka.consumer({
    kafkaJS: { groupId: `g-${crypto.randomUUID()}`, fromBeginning: true },
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  const got: { key: string; event: Event; headers: Record<string, string> }[] = [];
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`only ${got.length}/${expected} messages`)),
      timeoutMs,
    );
    void consumer.run({
      eachMessage: async ({ message }) => {
        const headers = Object.fromEntries(
          Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)]),
        );
        got.push({
          key: String(message.key),
          event: fromBinary(EventSchema, message.value as Buffer),
          headers,
        });
        if (got.length >= expected) {
          clearTimeout(t);
          resolve();
        }
      },
    });
  });
  await consumer.disconnect();
  return got;
}

beforeAll(async () => {
  const port = await freePort();
  [pgc, kafkac] = await Promise.all([
    new PostgreSqlContainer('postgres:17.11').start(),
    new GenericContainer('apache/kafka:4.4.0')
      .withExposedPorts({ container: port, host: port })
      .withEnvironment({
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: `PLAINTEXT://:${port},CONTROLLER://:9093`,
        KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:${port}`,
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
        KAFKA_HEAP_OPTS: '-Xms256m -Xmx256m',
      })
      .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
      .start(),
  ]);
  brokers = [`localhost:${port}`];
  await kafkac.exec([
    '/opt/kafka/bin/kafka-topics.sh',
    '--bootstrap-server',
    `localhost:${port}`,
    '--create',
    '--topic',
    'warden.decisions.v1',
    '--partitions',
    '3',
  ]);
  pool = new pg.Pool({ connectionString: pgc.getConnectionUri(), max: 10 });
  await pool.query(outboxSchemaSql);
  publisher = await KafkaPublisher.connect(brokers, 'outbox-test');
}, 180_000);

afterAll(async () => {
  await publisher?.close();
  await pool?.end();
  await Promise.all([pgc?.stop(), kafkac?.stop()]);
});

beforeEach(async () => {
  await pool.query('truncate outbox, inbox');
});

describe('outbox', () => {
  it('publishes nothing when the business transaction rolls back', async () => {
    await inTx((c) => enqueue(c, decision('c_rollback')), false);
    const relay = new OutboxRelay({ pool, publisher, lockKey: 1 });
    expect(await relay.drainOnce()).toBe(0);
  });

  it('ignores an event id it has already stored', async () => {
    const e = decision('c_dupe');
    await inTx((c) => enqueue(c, e));
    await inTx((c) => enqueue(c, e));
    const { rows } = await pool.query('select count(*)::int as n from outbox');
    expect(rows[0].n).toBe(1);
  });

  it('publishes committed events in order, keyed by aggregate, with headers', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await inTx(async (c) => {
      for (const id of ids) await enqueue(c, decision('c_order', id), '00-abc-def-01');
    });
    const relay = new OutboxRelay({ pool, publisher, lockKey: 2 });
    expect(await relay.drainOnce()).toBe(3);

    const got = (await readTopic('warden.decisions.v1', 3)).filter((m) => m.key === 'c_order');
    expect(got.map((m) => m.event.eventId)).toEqual(ids);
    expect(got[0]?.headers).toMatchObject({
      'event-id': ids[0],
      'event-type': 'decisionMade',
      traceparent: '00-abc-def-01',
    });
    const { rows } = await pool.query(
      'select count(*)::int as n from outbox where published_at is null',
    );
    expect(rows[0].n).toBe(0);
  }, 60_000);

  it('keeps events unpublished when kafka fails, and sends them once it recovers', async () => {
    await inTx((c) => enqueue(c, decision('c_retry')));
    let calls = 0;
    const flaky: Publisher = {
      publish: async (ms) => {
        calls++;
        if (calls === 1) throw new Error('broker unavailable');
        await publisher.publish(ms);
      },
    };
    const relay = new OutboxRelay({ pool, publisher: flaky, lockKey: 3 });
    await expect(relay.drainOnce()).rejects.toThrow('broker unavailable');
    const pending = await pool.query(
      'select count(*)::int as n from outbox where published_at is null',
    );
    expect(pending.rows[0].n).toBe(1);
    expect(await relay.drainOnce()).toBe(1);
  }, 60_000);

  it('lets only one relay lead, and the running leader wakes on insert', async () => {
    const sent: string[] = [];
    const recording: Publisher = { publish: async (ms) => void sent.push(...ms.map((m) => m.key)) };
    const a = new OutboxRelay({ pool, publisher: recording, lockKey: 4, pollMs: 60_000 });
    const b = new OutboxRelay({ pool, publisher: recording, lockKey: 4, pollMs: 60_000 });
    a.start();
    b.start();
    await new Promise((r) => setTimeout(r, 300));

    await inTx((c) => enqueue(c, decision('c_leader')));
    // poll interval is a minute, so delivery this fast means notify woke the leader
    const deadline = Date.now() + 5_000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await Promise.all([a.stop(), b.stop()]);
    expect(sent).toEqual(['c_leader']);
  }, 30_000);
});

describe('inbox', () => {
  it('runs a handler once per event even when the event is redelivered', async () => {
    await pool.query('create table if not exists seen (n int)');
    const id = crypto.randomUUID();
    const handler = (tx: pg.PoolClient) => tx.query('insert into seen values (1)').then(() => {});
    expect(await handleOnce(pool, 'ledger', id, handler)).toBe(true);
    expect(await handleOnce(pool, 'ledger', id, handler)).toBe(false);
    // a different consumer still gets its own copy
    expect(await handleOnce(pool, 'notifier', id, handler)).toBe(true);
    const { rows } = await pool.query('select count(*)::int as n from seen');
    expect(rows[0].n).toBe(2);
  });

  it('does not mark the event handled when the handler fails', async () => {
    const id = crypto.randomUUID();
    await expect(
      handleOnce(pool, 'ledger', id, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await handleOnce(pool, 'ledger', id, async () => {})).toBe(true);
  });
});
