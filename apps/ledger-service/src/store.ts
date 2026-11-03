import { createHash } from 'node:crypto';
import { toJsonString } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { type Event, EventSchema, Outcome } from '@warden/contracts';
import type pg from 'pg';

export const schemaSql = `
create table if not exists ledger (
  seq bigserial primary key,
  event_id uuid not null unique,
  call_id text not null,
  type text not null,
  occurred_at timestamptz not null,
  producer text not null,
  data_json text not null,
  prev_hash text not null,
  hash text not null,
  recorded_at timestamptz not null default now()
);
create index if not exists ledger_call on ledger (call_id, seq);

-- the ledger is append-only: rows can be added, never changed or removed
create or replace function ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger rows are append-only';
end $$;
drop trigger if exists ledger_append_only on ledger;
create trigger ledger_append_only before update or delete on ledger
  for each row execute function ledger_append_only();

create table if not exists calls (
  call_id text primary key,
  agent_id text,
  tool text,
  tier int,
  amount_value text,
  currency text,
  counterparty text,
  status text not null default 'received',
  reasons jsonb not null default '[]',
  decided_by text,
  upstream_ref text,
  received_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists calls_recent on calls (updated_at desc);

-- events for one call arrive on several topics, so their order isn't guaranteed. a status
-- only moves forward, so a late "received" never hides a decision.
create or replace function call_rank(s text) returns int language sql immutable as $$
  select case s when 'received' then 0 when 'pending_approval' then 1
    when 'allowed' then 2 when 'denied' then 2 else 3 end
$$;
`;

export const GENESIS = '0'.repeat(64);
const CHAIN_LOCK = 0x6c656467;

export const chainHash = (prev: string, dataJson: string) =>
  createHash('sha256').update(prev).update('\n').update(dataJson).digest('hex');

export async function append(tx: pg.PoolClient, event: Event): Promise<void> {
  const dataJson = toJsonString(EventSchema, event);
  // one writer at a time, so every row links to the one before it
  await tx.query('select pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
  const last = await tx.query<{ hash: string }>(
    'select hash from ledger order by seq desc limit 1',
  );
  const prev = last.rows[0]?.hash ?? GENESIS;
  await tx.query(
    `insert into ledger (event_id, call_id, type, occurred_at, producer, data_json, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.eventId,
      event.aggregateId,
      event.payload.case ?? 'unknown',
      event.occurredAt ? timestampDate(event.occurredAt) : new Date(),
      event.producer,
      dataJson,
      prev,
      chainHash(prev, dataJson),
    ],
  );
  await project(tx, event);
}

// fills the call's read model. columns only ever get filled in, never blanked.
async function setStatus(
  tx: pg.PoolClient,
  callId: string,
  status: string,
  fields: Record<string, unknown> = {},
) {
  const cols = Object.keys(fields);
  await tx.query('insert into calls (call_id) values ($1) on conflict do nothing', [callId]);
  await tx.query(
    `update calls set
       status = case when call_rank($2) >= call_rank(status) then $2 else status end,
       ${cols.map((c, i) => `${c} = coalesce($${i + 3}, ${c}), `).join('')}updated_at = now()
     where call_id = $1`,
    [callId, status, ...Object.values(fields)],
  );
}

async function project(tx: pg.PoolClient, event: Event) {
  const p = event.payload;
  switch (p.case) {
    case 'callReceived': {
      const i = p.value.intent;
      if (!i) return;
      return setStatus(tx, event.aggregateId, 'received', {
        agent_id: i.agentId,
        tool: i.tool,
        tier: i.tier,
        amount_value: i.amount?.value ?? null,
        currency: i.amount?.currency ?? null,
        counterparty: i.counterparty ?? null,
        received_at: event.occurredAt ? timestampDate(event.occurredAt) : new Date(),
      });
    }
    case 'approvalRequested':
      return setStatus(tx, event.aggregateId, 'pending_approval', {
        reasons: JSON.stringify(p.value.reasons),
      });
    case 'decisionMade':
      return setStatus(
        tx,
        event.aggregateId,
        p.value.outcome === Outcome.ALLOW ? 'allowed' : 'denied',
        {
          reasons: JSON.stringify(p.value.reasons),
          decided_by:
            ['unspecified', 'policy', 'judge', 'human', 'timeout'][p.value.decidedBy] ??
            'unspecified',
        },
      );
    case 'paymentExecuted':
      return setStatus(
        tx,
        event.aggregateId,
        p.value.ok ? 'executed' : p.value.errorCode === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed',
        { upstream_ref: p.value.upstreamRef ?? null },
      );
    default:
      return;
  }
}

export type CallRow = {
  call_id: string;
  agent_id: string | null;
  tool: string | null;
  tier: number | null;
  amount_value: string | null;
  currency: string | null;
  counterparty: string | null;
  status: string;
  reasons: { code: string; message: string; check: string }[];
  decided_by: string | null;
  upstream_ref: string | null;
  received_at: Date | null;
  updated_at: Date;
};

export type EntryRow = {
  seq: string;
  event_id: string;
  type: string;
  occurred_at: Date;
  producer: string;
  data_json: string;
  prev_hash: string;
  hash: string;
};

export async function listCalls(
  pool: pg.Pool,
  q: { agentId?: string; statuses?: string[]; limit: number },
) {
  const { rows } = await pool.query<CallRow>(
    `select * from calls
     where ($1::text is null or agent_id = $1) and (cardinality($2::text[]) = 0 or status = any($2))
     order by updated_at desc limit $3`,
    [q.agentId || null, q.statuses ?? [], Math.min(Math.max(q.limit, 1), 500)],
  );
  return rows;
}

export async function getCall(pool: pg.Pool, callId: string) {
  const call = await pool.query<CallRow>('select * from calls where call_id = $1', [callId]);
  const entries = await pool.query<EntryRow>(
    'select * from ledger where call_id = $1 order by occurred_at, seq',
    [callId],
  );
  return { call: call.rows[0], entries: entries.rows };
}

// walks the whole chain and reports the first row whose hash doesn't follow from the one before
export async function verifyChain(
  pool: pg.Pool,
): Promise<{ ok: boolean; entries: number; firstBadSeq?: string }> {
  const { rows } = await pool.query<{
    seq: string;
    data_json: string;
    prev_hash: string;
    hash: string;
  }>('select seq, data_json, prev_hash, hash from ledger order by seq');
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== chainHash(prev, r.data_json)) {
      return { ok: false, entries: rows.length, firstBadSeq: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}
