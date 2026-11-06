import type { Client as RpcClient } from '@connectrpc/connect';
import { type Client as TemporalClient, WorkflowNotFoundError } from '@temporalio/client';
import type { LedgerService } from '@warden/contracts';

export type Ledger = RpcClient<typeof LedgerService>;

async function waiting(temporal: TemporalClient, callId: string): Promise<boolean> {
  const handle = temporal.workflow.getHandle(callId);
  try {
    const d = await handle.describe();
    return (
      d.status.name === 'RUNNING' && (await handle.query<string>('status')) === 'awaiting_approval'
    );
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return false;
    throw err;
  }
}

// the ledger says what's pending; temporal says whether it's still waiting, since the
// ledger can trail by a moment and a call may have just timed out
export async function pendingApprovals(ledger: Ledger, temporal: TemporalClient) {
  const { calls } = await ledger.listCalls({ statuses: ['pending_approval'], limit: 50 });
  const out = [];
  for (const c of calls) {
    if (!(await waiting(temporal, c.callId))) continue;
    const { entries } = await ledger.getCall({ callId: c.callId });
    const requested = entries.find((e) => e.type === 'approvalRequested');
    const expiresAt = requested
      ? (JSON.parse(requested.dataJson) as { approvalRequested?: { expiresAt?: string } })
          .approvalRequested?.expiresAt
      : undefined;
    out.push({ call: c, expiresAt, requestedAt: requested?.occurredAt });
  }
  return out;
}

// needs_passkey: the approval is too big to give without the owner's passkey
export type Decided = 'sent' | 'not_waiting' | 'needs_passkey';

export async function decide(
  temporal: TemporalClient,
  callId: string,
  approved: boolean,
  by: string,
  receipt?: string,
): Promise<Decided> {
  if (!(await waiting(temporal, callId))) return 'not_waiting';
  await temporal.workflow.getHandle(callId).signal('decide', { approved, by, receipt });
  return 'sent';
}
