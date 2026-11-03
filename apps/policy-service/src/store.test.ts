import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parsePolicyFile } from './engine/policy-file.js';
import { type Intent, PolicyStore } from './store.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PolicyStore;

const policyFile = parsePolicyFile(`
agents:
  ops-agent:
    max_per_call: { value: "150.00", currency: USD }
    daily_budget: { value: "300.00", currency: USD }
    velocity: { max_calls: 5, per_seconds: 60, tiers: [T3] }
    duplicate_window_seconds: 300
    escalate_when: [NO_MANDATE, COUNTERPARTY_NOT_IN_MANDATE, OVER_MANDATE_PER_CALL_CAP, OVER_MANDATE_TOTAL]
`);

let n = 0;
const payout = (over: Partial<Intent> = {}): Intent => ({
  callId: `c_${++n}`,
  agentId: 'ops-agent',
  tool: 'send_payout',
  tier: 'T3',
  amountMinor: 2000n,
  currency: 'USD',
  counterparty: 'dev@studio.example',
  fingerprint: `fp_${n}`,
  ...over,
});

const mandate = (over: Partial<Parameters<PolicyStore['createMandate']>[0]> = {}) =>
  store.createMandate({
    agent_id: 'ops-agent',
    user_id: 'priya',
    task: 'pay approved contractor invoices',
    currency: 'USD',
    maxPerCallMinor: 5000n,
    maxTotalMinor: 5000n,
    counterparties: ['Dev@Studio.example'],
    tools: ['send_payout'],
    expires_at: new Date(Date.now() + 3_600_000),
    ...over,
  });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.11').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 20 });
  store = new PolicyStore(pool, policyFile);
  await store.migrate();
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query('truncate evaluations, reservations, mandates cascade');
});

describe('PolicyStore', () => {
  it('answers a retried call id with the first decision and holds once', async () => {
    await mandate();
    const intent = payout();
    const a = await store.evaluateAndReserve(intent);
    const b = await store.evaluateAndReserve(intent);
    expect(a.outcome).toBe('allow');
    expect(b).toEqual(a);
    const { rows } = await pool.query('select count(*)::int as n from reservations');
    expect(rows[0].n).toBe(1);
  });

  it('never lets parallel calls overspend a mandate', async () => {
    await mandate();
    const results = await Promise.all(
      [payout(), payout(), payout()].map((i) => store.evaluateAndReserve(i)),
    );
    expect(results.filter((r) => r.outcome === 'allow')).toHaveLength(2);
    expect(results.find((r) => r.outcome !== 'allow')?.reasons.map((r) => r.code)).toContain(
      'OVER_MANDATE_TOTAL',
    );
  });

  it('frees a released hold and keeps a settled one', async () => {
    const m = await mandate();
    const a = await store.evaluateAndReserve(payout({ amountMinor: 3000n }));
    await store.release(a.reservationId as string, 'upstream failed');
    const b = await store.evaluateAndReserve(payout({ amountMinor: 3000n }));
    expect(b.outcome).toBe('allow');
    await store.settle(b.reservationId as string, 3000n, 'B1');
    await store.settle(b.reservationId as string, 3000n, 'B1');
    await store.release(b.reservationId as string, 'late release');
    const [row] = await store.mandates({ id: m.id });
    expect(row).toMatchObject({ spent_minor: '3000', reserved_minor: '0' });
    await expect(store.settle(a.reservationId as string, 3000n, 'X')).rejects.toThrow(/released/);
  });

  it('treats releasing an unknown hold as done, but refuses to settle one', async () => {
    await expect(store.release('res_missing', 'cleanup')).resolves.toBeUndefined();
    await expect(store.settle('res_missing', 100n, 'X')).rejects.toThrow(/missing/);
  });

  it('flags a repeat of a recent payment, but not one that was denied', async () => {
    await mandate({ maxTotalMinor: 100000n, maxPerCallMinor: 20000n });
    // over the agent's 150.00 cap, so denied and holds nothing
    const denied = await store.evaluateAndReserve(
      payout({ fingerprint: 'fp_same', amountMinor: 16000n }),
    );
    expect(denied.outcome).toBe('deny');
    expect((await store.evaluateAndReserve(payout({ fingerprint: 'fp_same' }))).outcome).toBe(
      'allow',
    );
    const again = await store.evaluateAndReserve(payout({ fingerprint: 'fp_same' }));
    expect(again).toMatchObject({ outcome: 'deny', reasons: [{ code: 'DUPLICATE_PAYMENT' }] });
  });

  it('counts holds against the daily budget across mandates', async () => {
    await mandate({ maxPerCallMinor: 15000n, maxTotalMinor: 100000n });
    for (const amt of [15000n, 15000n])
      expect((await store.evaluateAndReserve(payout({ amountMinor: amt }))).outcome).toBe('allow');
    const over = await store.evaluateAndReserve(payout({ amountMinor: 1n }));
    expect(over).toMatchObject({ outcome: 'deny', reasons: [{ code: 'OVER_DAILY_BUDGET' }] });
  });

  it('stops a burst of payments', async () => {
    await mandate({ maxPerCallMinor: 100n, maxTotalMinor: 100000n });
    const outcomes = [];
    for (let i = 0; i < 6; i++)
      outcomes.push((await store.evaluateAndReserve(payout({ amountMinor: 100n }))).outcome);
    expect(outcomes).toEqual(['allow', 'allow', 'allow', 'allow', 'allow', 'deny']);
  });

  it('ignores revoked and expired mandates', async () => {
    const m = await mandate();
    await store.revokeMandate(m.id);
    await mandate({ expires_at: new Date(Date.now() - 1000) });
    const r = await store.evaluateAndReserve(payout());
    expect(r).toMatchObject({ outcome: 'escalate', reasons: [{ code: 'NO_MANDATE' }] });
  });

  it('denies agents with no policy', async () => {
    const r = await store.evaluateAndReserve(payout({ agentId: 'stranger' }));
    expect(r).toMatchObject({ outcome: 'deny', reasons: [{ code: 'UNKNOWN_AGENT' }] });
  });

  it("keeps an escalated payment off the mandate's budget but on the daily one", async () => {
    const m = await mandate({ maxPerCallMinor: 10000n, maxTotalMinor: 10000n });
    const held = await store.evaluateAndReserve(
      payout({ counterparty: 'new-bank@attacker.example', amountMinor: 9600n }),
    );
    expect(held.outcome).toBe('escalate');
    // the contractor can still be paid the full mandate while the attacker's payout waits
    expect((await store.evaluateAndReserve(payout({ amountMinor: 10000n }))).outcome).toBe('allow');
    const [row] = await store.mandates({ id: m.id });
    expect(row?.reserved_minor).toBe('10000');
    const daily = await store.evaluateAndReserve(
      payout({ counterparty: 'other@x.com', amountMinor: 15000n }),
    );
    expect(daily.reasons.map((r) => r.code)).toContain('OVER_DAILY_BUDGET');
  });

  it('holds the amount while a human decides', async () => {
    await mandate();
    const r = await store.evaluateAndReserve(payout({ counterparty: 'new-contractor@x.com' }));
    expect(r.outcome).toBe('escalate');
    expect(r.reservationId).toBeDefined();
  });
});
