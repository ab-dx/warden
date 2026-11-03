import { create } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type Event, EventSchema, Outcome, Tier } from '@warden/contracts';
import { handleOnce, outboxSchemaSql } from '@warden/outbox';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { append, GENESIS, getCall, schemaSql, verifyChain } from './store.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.11').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await pool.query(outboxSchemaSql);
  await pool.query(schemaSql);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  // tests reset the table, which the append-only trigger would otherwise refuse
  await pool.query(
    'alter table ledger disable trigger ledger_append_only; truncate ledger, calls, inbox; alter table ledger enable trigger ledger_append_only',
  );
});

const ev = (callId: string, payload: Event['payload']): Event =>
  create(EventSchema, {
    eventId: crypto.randomUUID(),
    occurredAt: timestampNow(),
    aggregateType: 'call',
    aggregateId: callId,
    producer: 'test',
    payload,
  });

const received = (callId: string) =>
  ev(callId, {
    case: 'callReceived',
    value: {
      intent: {
        callId,
        agentId: 'ops-agent',
        tool: 'send_payout',
        tier: Tier.MONEY_OUT,
        amount: { value: '20.00', currency: 'USD' },
        counterparty: 'dev@studio.example',
      },
    },
  });
const decided = (callId: string, outcome: Outcome) =>
  ev(callId, {
    case: 'decisionMade',
    value: { callId, outcome, reasons: [{ code: 'X', message: 'x', check: 'policy' }] },
  });
const executed = (callId: string, ok: boolean, errorCode?: string) =>
  ev(callId, {
    case: 'paymentExecuted',
    value: {
      callId,
      tool: 'send_payout',
      ok,
      upstreamRef: 'B1',
      ...(errorCode ? { errorCode } : {}),
    },
  });

async function write(...events: Event[]) {
  for (const e of events) await handleOnce(pool, 'ledger', e.eventId, (tx) => append(tx, e));
}

describe('ledger', () => {
  it('links every entry to the one before it', async () => {
    await write(received('c1'), decided('c1', Outcome.ALLOW), executed('c1', true));
    const { entries } = await getCall(pool, 'c1');
    expect(entries[0]?.prev_hash).toBe(GENESIS);
    expect(entries[1]?.prev_hash).toBe(entries[0]?.hash);
    expect(await verifyChain(pool)).toEqual({ ok: true, entries: 3 });
  });

  it('refuses to change or remove entries', async () => {
    await write(received('c1'));
    await expect(pool.query(`update ledger set data_json = '{}'`)).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from ledger')).rejects.toThrow(/append-only/);
  });

  it('spots tampering done around the database guard', async () => {
    await write(received('c1'), decided('c1', Outcome.DENY), received('c2'));
    await pool.query(`alter table ledger disable trigger ledger_append_only;
      update ledger set data_json = replace(data_json, 'DENY', 'ALLOW') where type = 'decisionMade';
      alter table ledger enable trigger ledger_append_only`);
    const r = await verifyChain(pool);
    expect(r.ok).toBe(false);
    const { rows } = await pool.query(`select seq from ledger where type = 'decisionMade'`);
    expect(r.firstBadSeq).toBe(rows[0].seq);
  });

  it('writes a redelivered event once', async () => {
    const e = received('c1');
    await write(e, e, e);
    expect((await getCall(pool, 'c1')).entries).toHaveLength(1);
  });

  it('builds the right status when events arrive out of order', async () => {
    await write(executed('c1', true), decided('c1', Outcome.ALLOW), received('c1'));
    const { call } = await getCall(pool, 'c1');
    expect(call).toMatchObject({
      status: 'executed',
      agent_id: 'ops-agent',
      tool: 'send_payout',
      amount_value: '20.00',
      upstream_ref: 'B1',
    });
  });

  it('lists a call timeline in the order things happened, not the order they arrived', async () => {
    const r = received('c1');
    const d = decided('c1', Outcome.ALLOW);
    d.occurredAt = { ...r.occurredAt!, seconds: r.occurredAt!.seconds + 1n };
    await write(d, r);
    expect((await getCall(pool, 'c1')).entries.map((e) => e.type)).toEqual([
      'callReceived',
      'decisionMade',
    ]);
  });

  it('tells failed from unknown outcomes', async () => {
    await write(
      received('c1'),
      executed('c1', false, 'PAYPAL_API_HTTP_ERROR'),
      received('c2'),
      executed('c2', false, 'OUTCOME_UNKNOWN'),
    );
    expect((await getCall(pool, 'c1')).call?.status).toBe('failed');
    expect((await getCall(pool, 'c2')).call?.status).toBe('unknown');
  });

  it('keeps the decision reasons for the evidence view', async () => {
    await write(received('c1'), decided('c1', Outcome.DENY));
    expect((await getCall(pool, 'c1')).call).toMatchObject({
      status: 'denied',
      reasons: [{ code: 'X' }],
    });
  });
});
