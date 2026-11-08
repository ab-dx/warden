import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import type { LedgerService } from '@warden/contracts';
import type pg from 'pg';
import { type CallRow, type EntryRow, getCall, listCalls, verifyChain } from './store.js';

const summary = (r: CallRow) => ({
  callId: r.call_id,
  agentId: r.agent_id ?? '',
  tool: r.tool ?? '',
  tier: r.tier ?? 0,
  ...(r.amount_value && r.currency
    ? { amount: { value: r.amount_value, currency: r.currency } }
    : {}),
  ...(r.counterparty ? { counterparty: r.counterparty } : {}),
  status: r.status,
  reasons: r.reasons,
  decidedBy: r.decided_by ?? '',
  ...(r.upstream_ref ? { upstreamRef: r.upstream_ref } : {}),
  ...(r.received_at ? { receivedAt: timestampFromDate(r.received_at) } : {}),
  updatedAt: timestampFromDate(r.updated_at),
});

const entry = (e: EntryRow) => ({
  seq: BigInt(e.seq),
  eventId: e.event_id,
  type: e.type,
  occurredAt: timestampFromDate(e.occurred_at),
  producer: e.producer,
  dataJson: e.data_json,
  prevHash: e.prev_hash,
  hash: e.hash,
});

export function ledgerService(pool: pg.Pool): ServiceImpl<typeof LedgerService> {
  return {
    async listCalls({ agentId, limit, statuses }) {
      const rows = await listCalls(pool, { agentId, statuses, limit: limit || 50 });
      return { calls: rows.map(summary) };
    },
    async getCall({ callId }) {
      const { call, entries } = await getCall(pool, callId);
      // a session id has entries (what the agent read) but no call row
      if (!call && !entries.length) throw new ConnectError(`no call ${callId}`, Code.NotFound);
      return { ...(call ? { call: summary(call) } : {}), entries: entries.map(entry) };
    },
    async verifyChain() {
      const r = await verifyChain(pool);
      return {
        ok: r.ok,
        entries: BigInt(r.entries),
        ...(r.firstBadSeq ? { firstBadSeq: BigInt(r.firstBadSeq) } : {}),
      };
    },
  };
}
