import { create } from '@bufbuild/protobuf';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MandateSchema, Outcome, PaymentIntentSchema, Tier } from '@warden/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgeService } from './service.js';
import { record, schemaSql, seen } from './store.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.11').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await pool.query(schemaSql);
  const mail = { sessionId: 's1', sourceTool: 'read_email' };
  await record(pool, { ...mail, tokens: ['email:arjun@mehta.example', 'amount:96.00'] });
  // a redelivered event changes nothing
  await record(pool, { ...mail, tokens: ['email:new-bank@attacker.example', 'amount:96.00'] });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const assess = (counterparty: string, sessionId = 's1', llm?: Parameters<typeof judgeService>[1]) =>
  judgeService((id) => seen(pool, id), llm).assess(
    {
      intent: create(PaymentIntentSchema, {
        sessionId,
        counterparty,
        tool: 'send_payout',
        tier: Tier.MONEY_OUT,
      }),
      mandates: [
        create(MandateSchema, {
          task: 'pay approved contractor invoices',
          counterparties: ['arjun@mehta.example'],
        }),
      ],
    } as never,
    {} as never,
  );

describe('provenance', () => {
  it('keeps one row per token a session read', async () => {
    expect((await seen(pool, 's1')).sort()).toEqual([
      'amount:96.00',
      'email:arjun@mehta.example',
      'email:new-bank@attacker.example',
    ]);
  });

  it('holds a payout to a payee that came only from an email', async () => {
    const r = await assess('new-bank@attacker.example');
    expect(r.outcome).toBe(Outcome.ESCALATE);
    expect(r.reasons?.[0]?.code).toBe('PAYEE_FROM_UNTRUSTED_CONTENT');
  });

  it('allows a payee the user named, or one this session never read', async () => {
    expect((await assess('arjun@mehta.example')).outcome).toBe(Outcome.ALLOW);
    expect((await assess('new-bank@attacker.example', 'other-session')).outcome).toBe(
      Outcome.ALLOW,
    );
  });
});

describe('llm judge', () => {
  it('adds its hold to the provenance one and can never clear a call', async () => {
    const yes = async () => ({ outcome: 'allow' as const, reasons: [] });
    const no = async () => ({
      outcome: 'escalate' as const,
      reasons: [{ code: 'JUDGE_GOAL_MISMATCH', message: 'm', check: 'judge' }],
    });
    const both = await assess('new-bank@attacker.example', 's1', no);
    expect(both.reasons?.map((r) => r.code)).toEqual([
      'PAYEE_FROM_UNTRUSTED_CONTENT',
      'JUDGE_GOAL_MISMATCH',
    ]);
    expect((await assess('new-bank@attacker.example', 's1', yes)).outcome).toBe(Outcome.ESCALATE);
    expect((await assess('arjun@mehta.example', 's1', no)).outcome).toBe(Outcome.ESCALATE);
    expect((await assess('arjun@mehta.example', 's1', yes)).outcome).toBe(Outcome.ALLOW);
  });
});
