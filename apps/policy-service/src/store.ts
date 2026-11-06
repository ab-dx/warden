import { randomUUID } from 'node:crypto';
import { contentTokens, emailToken, type Outcome, type Reason, tighten } from '@warden/core';
import type pg from 'pg';
import {
  capEscalations,
  compile,
  evaluate,
  type Facts,
  type Tier,
  type Verdict,
  withinHours,
} from './engine/engine.js';
import type { PolicyFile } from './engine/policy-file.js';

export const schemaSql = `
create table if not exists mandates (
  id text primary key,
  agent_id text not null,
  user_id text not null,
  task text not null,
  currency text not null,
  max_per_call_minor bigint not null check (max_per_call_minor > 0),
  max_total_minor bigint not null check (max_total_minor >= max_per_call_minor),
  counterparties text[] not null default '{}',
  tools text[] not null,
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now()
);
create index if not exists mandates_agent on mandates (agent_id, created_at desc);

create table if not exists evaluations (
  call_id text primary key,
  agent_id text not null,
  tool text not null,
  tier text not null,
  fingerprint text not null,
  counterparty text,
  outcome text not null,
  reasons jsonb not null,
  mandate_id text references mandates (id),
  reservation_id text,
  created_at timestamptz not null default now()
);
create index if not exists evaluations_agent on evaluations (agent_id, created_at);
create index if not exists evaluations_fingerprint on evaluations (agent_id, fingerprint, created_at);
-- added after the first release, so older databases get it here
alter table evaluations add column if not exists counterparty text;
create index if not exists evaluations_counterparty on evaluations (agent_id, counterparty, created_at);

create table if not exists reservations (
  id text primary key,
  call_id text not null unique,
  agent_id text not null,
  mandate_id text references mandates (id),
  currency text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  settled_minor bigint,
  status text not null check (status in ('reserved', 'settled', 'released')),
  upstream_ref text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reservations_agent on reservations (agent_id, created_at);
create index if not exists reservations_mandate on reservations (mandate_id);
`;

export type Intent = {
  callId: string;
  agentId: string;
  tool: string;
  tier: Tier;
  amountMinor?: bigint | undefined;
  currency?: string | undefined;
  counterparty?: string | undefined;
  fingerprint: string;
  // reasons from checks that ran before policy (provenance); they only tighten
  escalations?: Reason[] | undefined;
};

export type Evaluated = Verdict & {
  reservationId?: string | undefined;
  mandateId?: string | undefined;
};

export type MandateRow = {
  id: string;
  agent_id: string;
  user_id: string;
  task: string;
  currency: string;
  max_per_call_minor: string;
  max_total_minor: string;
  counterparties: string[];
  tools: string[];
  expires_at: Date;
  status: 'active' | 'revoked';
  spent_minor: string;
  reserved_minor: string;
};

export type NewMandate = Omit<
  MandateRow,
  'id' | 'status' | 'spent_minor' | 'reserved_minor' | 'max_per_call_minor' | 'max_total_minor'
> & {
  maxPerCallMinor: bigint;
  maxTotalMinor: bigint;
};

// amounts that still count against a budget: held or already paid
const LIVE = `status in ('reserved', 'settled')`;
const USED = `coalesce(sum(coalesce(settled_minor, amount_minor)), 0)`;

export class PolicyStore {
  private readonly compiled = new Map<string, Record<string, string>>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly policyFile: PolicyFile,
  ) {}

  async migrate() {
    await this.pool.query(schemaSql);
  }

  // safe to call again with the same call id: the first answer is returned, nothing is held twice
  async evaluateAndReserve(intent: Intent): Promise<Evaluated> {
    const policy = this.policyFile.agents[intent.agentId];
    if (!policy) {
      return {
        outcome: 'deny',
        reasons: [
          {
            code: 'UNKNOWN_AGENT',
            message: `No policy is configured for agent ${intent.agentId}.`,
            check: 'policy',
          },
        ],
      };
    }
    let policies = this.compiled.get(intent.agentId);
    if (!policies) {
      policies = compile(policy);
      this.compiled.set(intent.agentId, policies);
    }

    const tx = await this.pool.connect();
    try {
      await tx.query('begin');
      // one decision at a time per agent, so two parallel calls can't both see the same headroom
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`agent:${intent.agentId}`]);

      const prior = await tx.query<{
        outcome: Outcome;
        reasons: Reason[];
        reservation_id: string | null;
        mandate_id: string | null;
      }>(
        'select outcome, reasons, reservation_id, mandate_id from evaluations where call_id = $1',
        [intent.callId],
      );
      if (prior.rows[0]) {
        await tx.query('commit');
        const p = prior.rows[0];
        return {
          outcome: p.outcome,
          reasons: p.reasons,
          reservationId: p.reservation_id ?? undefined,
          mandateId: p.mandate_id ?? undefined,
        };
      }

      const mandate = await this.resolveMandate(tx, intent);
      const daily = await tx.query<{ used: string }>(
        `select ${USED} as used from reservations
         where agent_id = $1 and currency = $2 and ${LIVE} and created_at > now() - interval '24 hours'`,
        [intent.agentId, policy.daily_budget.currency],
      );
      const recent = await tx.query<{ n: number }>(
        `select count(*)::int as n from evaluations
         where agent_id = $1 and tier = any($2) and created_at > now() - make_interval(secs => $3)`,
        [intent.agentId, policy.velocity.tiers, policy.velocity.per_seconds],
      );
      const dup = await tx.query<{ n: number }>(
        `select count(*)::int as n from evaluations
         where agent_id = $1 and fingerprint = $2 and outcome <> 'deny'
           and created_at > now() - make_interval(secs => $3)`,
        [intent.agentId, intent.fingerprint, policy.duplicate_window_seconds],
      );

      const payee = intent.counterparty?.toLowerCase();
      const toPayee =
        payee && intent.currency && policy.split_window_seconds > 0
          ? await tx.query<{ used: string }>(
              `select ${USED} as used from reservations r join evaluations e on e.call_id = r.call_id
               where r.agent_id = $1 and e.counterparty = $2 and r.currency = $3 and ${LIVE}
                 and r.created_at > now() - make_interval(secs => $4)`,
              [intent.agentId, payee, intent.currency, policy.split_window_seconds],
            )
          : undefined;

      const facts: Facts = {
        tool: intent.tool,
        tier: intent.tier,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        counterparty: intent.counterparty,
        mandate,
        dailyRemainingMinor: policy.daily_budget.minor - BigInt(daily.rows[0]?.used ?? 0),
        recentCalls: recent.rows[0]?.n ?? 0,
        duplicate: (dup.rows[0]?.n ?? 0) > 0,
        payeeRecentMinor: BigInt(toPayee?.rows[0]?.used ?? 0),
        withinHours: policy.allowed_hours ? withinHours(new Date(), policy.allowed_hours) : true,
        newPayee: policy.new_payee_review_above
          ? await this.newPayee(tx, intent.agentId, payee, mandate)
          : false,
      };
      const held =
        policy.max_escalations_per_hour > 0
          ? await tx.query<{ n: number }>(
              `select count(*)::int as n from evaluations
               where agent_id = $1 and outcome = 'escalate' and created_at > now() - interval '1 hour'`,
              [intent.agentId],
            )
          : undefined;
      const verdict = capEscalations(
        tighten(evaluate(policy, policies, facts), {
          outcome: intent.escalations?.length ? 'escalate' : 'allow',
          reasons: intent.escalations ?? [],
        }),
        held?.rows[0]?.n ?? 0,
        policy.max_escalations_per_hour,
      );

      // hold the amount while a human decides too, so parallel calls can't spend it meanwhile.
      // only a call the mandate allowed by itself draws on the mandate; anything escalated is
      // outside it, so a held attacker payout can't eat the budget the user gave for real work.
      let reservationId: string | undefined;
      if (verdict.outcome !== 'deny' && intent.amountMinor !== undefined && intent.currency) {
        reservationId = `res_${randomUUID()}`;
        await tx.query(
          `insert into reservations (id, call_id, agent_id, mandate_id, currency, amount_minor, status)
           values ($1, $2, $3, $4, $5, $6, 'reserved')`,
          [
            reservationId,
            intent.callId,
            intent.agentId,
            verdict.outcome === 'allow' ? (mandate?.id ?? null) : null,
            intent.currency,
            intent.amountMinor.toString(),
          ],
        );
      }
      await tx.query(
        `insert into evaluations (call_id, agent_id, tool, tier, fingerprint, counterparty, outcome, reasons, mandate_id, reservation_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          intent.callId,
          intent.agentId,
          intent.tool,
          intent.tier,
          intent.fingerprint,
          payee ?? null,
          verdict.outcome,
          JSON.stringify(verdict.reasons),
          mandate?.id ?? null,
          reservationId ?? null,
        ],
      );
      await tx.query('commit');
      return { ...verdict, reservationId, mandateId: mandate?.id };
    } catch (err) {
      await tx.query('rollback').catch(() => {});
      throw err;
    } finally {
      tx.release();
    }
  }

  // an email payee the user didn't write anywhere in the mandate, and that this agent has
  // never paid successfully. a settled payment is one paypal accepted, so a held, denied or
  // refused one doesn't make a payee familiar
  private async newPayee(
    tx: pg.PoolClient,
    agentId: string,
    payee: string | undefined,
    mandate: Facts['mandate'],
  ) {
    if (!payee?.includes('@')) return false;
    const t = emailToken(payee);
    const named = [mandate?.task ?? '', ...(mandate?.counterparties ?? [])].some((text) =>
      contentTokens(text).includes(t),
    );
    if (named) return false;
    const { rows } = await tx.query(
      `select 1 from reservations r join evaluations e on e.call_id = r.call_id
       where r.agent_id = $1 and e.counterparty = $2 and r.status = 'settled' limit 1`,
      [agentId, payee],
    );
    return rows.length === 0;
  }

  private async resolveMandate(tx: pg.PoolClient, intent: Intent): Promise<Facts['mandate']> {
    const { rows } = await tx.query<{
      id: string;
      task: string;
      counterparties: string[];
      max_per_call_minor: string;
      max_total_minor: string;
      currency: string;
      used: string;
    }>(
      `select m.id, m.task, m.counterparties, m.max_per_call_minor, m.max_total_minor, m.currency,
              (select ${USED} from reservations r where r.mandate_id = m.id and r.${LIVE}) as used
       from mandates m
       where m.agent_id = $1 and m.status = 'active' and m.expires_at > now() and $2 = any(m.tools)
       order by m.created_at desc limit 1`,
      [intent.agentId, intent.tool],
    );
    const m = rows[0];
    if (!m) return undefined;
    return {
      id: m.id,
      task: m.task,
      counterparties: m.counterparties,
      maxPerCallMinor: BigInt(m.max_per_call_minor),
      remainingMinor: BigInt(m.max_total_minor) - BigInt(m.used),
      currency: m.currency,
    };
  }

  // settling twice is fine; settling a released hold is refused rather than resurrected
  async settle(reservationId: string, settledMinor: bigint | undefined, upstreamRef: string) {
    const { rows } = await this.pool.query<{ status: string }>(
      `update reservations set status = 'settled', settled_minor = coalesce($2, amount_minor),
         upstream_ref = $3, updated_at = now()
       where id = $1 and status = 'reserved'
       returning status`,
      [reservationId, settledMinor?.toString() ?? null, upstreamRef],
    );
    if (rows.length) return;
    const now = await this.status(reservationId);
    if (now !== 'settled')
      throw new Error(`cannot settle reservation ${reservationId} in state ${now}`);
  }

  // releasing a settled hold would hand back money that already left, so that is a no-op.
  // so is releasing one that doesn't exist: there is nothing to free, and refusing would
  // only leave the caller retrying forever.
  async release(reservationId: string, reason: string) {
    await this.pool.query(
      `update reservations set status = 'released', reason = $2, updated_at = now()
       where id = $1 and status = 'reserved'`,
      [reservationId, reason],
    );
  }

  private async status(id: string) {
    const { rows } = await this.pool.query<{ status: string }>(
      'select status from reservations where id = $1',
      [id],
    );
    return rows[0]?.status ?? 'missing';
  }

  async createMandate(m: NewMandate): Promise<MandateRow> {
    const id = `mdt_${randomUUID()}`;
    await this.pool.query(
      `insert into mandates (id, agent_id, user_id, task, currency, max_per_call_minor, max_total_minor, counterparties, tools, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        m.agent_id,
        m.user_id,
        m.task,
        m.currency,
        m.maxPerCallMinor.toString(),
        m.maxTotalMinor.toString(),
        m.counterparties.map((c) => c.toLowerCase()),
        m.tools,
        m.expires_at,
      ],
    );
    return (await this.mandates({ id }))[0] as MandateRow;
  }

  async revokeMandate(id: string): Promise<MandateRow | undefined> {
    await this.pool.query(`update mandates set status = 'revoked' where id = $1`, [id]);
    return (await this.mandates({ id }))[0];
  }

  // what each agent has held or spent in the last 24 hours, by the same sum the daily rule uses
  async budgets() {
    const out = [];
    for (const [agentId, p] of Object.entries(this.policyFile.agents)) {
      const { rows } = await this.pool.query<{ used: string }>(
        `select ${USED} as used from reservations
         where agent_id = $1 and currency = $2 and ${LIVE} and created_at > now() - interval '24 hours'`,
        [agentId, p.daily_budget.currency],
      );
      out.push({
        agentId,
        currency: p.daily_budget.currency,
        limitMinor: p.daily_budget.minor,
        usedMinor: BigInt(rows[0]?.used ?? 0),
      });
    }
    return out;
  }

  async mandates(where: { id?: string; agentId?: string }): Promise<MandateRow[]> {
    const { rows } = await this.pool.query<MandateRow>(
      `select m.*,
         (select coalesce(sum(coalesce(settled_minor, amount_minor)), 0) from reservations r where r.mandate_id = m.id and r.status = 'settled') as spent_minor,
         (select coalesce(sum(amount_minor), 0) from reservations r where r.mandate_id = m.id and r.status = 'reserved') as reserved_minor
       from mandates m
       where ($1::text is null or m.id = $1) and ($2::text is null or m.agent_id = $2)
       order by m.created_at desc`,
      [where.id ?? null, where.agentId ?? null],
    );
    return rows;
  }
}
