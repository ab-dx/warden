import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import {
  MandateStatus,
  Outcome,
  type PaymentIntent,
  type PolicyService,
  Tier,
} from '@warden/contracts';
import { fromMinor, toMinor } from '@warden/core';
import { z } from 'zod';
import type { Tier as EngineTier } from './engine/engine.js';
import type { PolicyFile } from './engine/policy-file.js';
import type { Intent, MandateRow, PolicyStore } from './store.js';

const TIERS: Partial<Record<Tier, EngineTier>> = {
  [Tier.READ]: 'T0',
  [Tier.WRITE]: 'T1',
  [Tier.COMMIT]: 'T2',
  [Tier.MONEY_OUT]: 'T3',
};
const OUTCOMES = { allow: Outcome.ALLOW, escalate: Outcome.ESCALATE, deny: Outcome.DENY } as const;
const MAX_MANDATE_MS = 30 * 24 * 3600_000;

const denyNow = (code: string, message: string) => ({
  outcome: Outcome.DENY,
  reasons: [{ code, message, check: 'policy' }],
});

// mandates come from people, through the dashboard, so they are checked hard here
const mandateInput = z
  .object({
    agentId: z.string().min(1),
    userId: z.string().min(1),
    task: z.string().trim().min(1).max(500),
    maxPerCall: z.object({ value: z.string(), currency: z.string() }),
    maxTotal: z.object({ value: z.string(), currency: z.string() }),
    counterparties: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9@._+-]{1,254}$/),
      )
      .max(50),
    tools: z
      .array(z.string().regex(/^[a-z_]{1,64}$/))
      .min(1)
      .max(20),
    expiresAt: z.date(),
  })
  .superRefine((m, ctx) => {
    if (m.maxPerCall.currency !== m.maxTotal.currency)
      ctx.addIssue({ code: 'custom', message: 'limits must share a currency' });
    const now = Date.now();
    if (m.expiresAt.getTime() <= now)
      ctx.addIssue({ code: 'custom', message: 'expiry must be in the future' });
    if (m.expiresAt.getTime() > now + MAX_MANDATE_MS)
      ctx.addIssue({ code: 'custom', message: 'mandates can last at most 30 days' });
  });

export function toIntent(p: PaymentIntent): Intent | { invalid: string } {
  const tier = TIERS[p.tier];
  if (!tier) return { invalid: 'unknown tier' };
  if (!p.callId || !p.agentId || !p.tool)
    return { invalid: 'call id, agent and tool are required' };
  let amountMinor: bigint | undefined;
  if (p.amount) {
    try {
      amountMinor = toMinor(p.amount);
    } catch {
      return { invalid: `unreadable amount ${p.amount.value} ${p.amount.currency}` };
    }
  }
  return {
    callId: p.callId,
    agentId: p.agentId,
    tool: p.tool,
    tier,
    amountMinor,
    currency: p.amount?.currency,
    counterparty: p.counterparty,
    // with no fingerprint every call would look unique and the duplicate rule would never fire
    fingerprint: p.fingerprint || `missing:${p.callId}`,
  };
}

function toProto(m: MandateRow) {
  const money = (minor: string) => fromMinor(BigInt(minor), m.currency);
  const expired = m.expires_at.getTime() <= Date.now();
  return {
    id: m.id,
    agentId: m.agent_id,
    userId: m.user_id,
    task: m.task,
    maxPerCall: money(m.max_per_call_minor),
    maxTotal: money(m.max_total_minor),
    spent: money(m.spent_minor),
    reserved: money(m.reserved_minor),
    counterparties: m.counterparties,
    tools: m.tools,
    expiresAt: timestampFromDate(m.expires_at),
    status:
      m.status === 'revoked'
        ? MandateStatus.REVOKED
        : expired
          ? MandateStatus.EXPIRED
          : MandateStatus.ACTIVE,
  };
}

export function policyService(
  store: PolicyStore,
  policyFile: PolicyFile,
): ServiceImpl<typeof PolicyService> {
  return {
    async evaluateAndReserve({ intent, escalations }) {
      if (!intent) return denyNow('INVALID_INTENT', 'no intent was sent');
      const parsed = toIntent(intent);
      if ('invalid' in parsed) return denyNow('INVALID_INTENT', parsed.invalid);
      const r = await store.evaluateAndReserve({
        ...parsed,
        escalations: escalations.map(({ code, message, check }) => ({ code, message, check })),
      });
      return {
        outcome: OUTCOMES[r.outcome],
        reasons: r.reasons,
        reservationId: r.reservationId,
        mandateId: r.mandateId,
      };
    },

    async settleReservation({ reservationId, settled, upstreamRef }) {
      let minor: bigint | undefined;
      try {
        minor = settled ? toMinor(settled) : undefined;
      } catch {
        throw new ConnectError('unreadable settled amount', Code.InvalidArgument);
      }
      await store.settle(reservationId, minor, upstreamRef);
      return {};
    },

    async releaseReservation({ reservationId, reason }) {
      await store.release(reservationId, reason);
      return {};
    },

    async createMandate({ mandate }) {
      const parsed = mandateInput.safeParse({
        ...mandate,
        expiresAt: mandate?.expiresAt ? timestampDate(mandate.expiresAt) : undefined,
      });
      if (!parsed.success) {
        throw new ConnectError(
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          Code.InvalidArgument,
        );
      }
      const m = parsed.data;
      const policy = policyFile.agents[m.agentId];
      if (!policy) throw new ConnectError(`no policy for agent ${m.agentId}`, Code.InvalidArgument);
      let perCall: bigint;
      let total: bigint;
      try {
        perCall = toMinor(m.maxPerCall);
        total = toMinor(m.maxTotal);
      } catch (err) {
        throw new ConnectError((err as Error).message, Code.InvalidArgument);
      }
      if (perCall <= 0n || total < perCall) {
        throw new ConnectError(
          'per-payment limit must be positive and no more than the total',
          Code.InvalidArgument,
        );
      }
      const row = await store.createMandate({
        agent_id: m.agentId,
        user_id: m.userId,
        task: m.task,
        currency: m.maxTotal.currency,
        maxPerCallMinor: perCall,
        maxTotalMinor: total,
        counterparties: m.counterparties,
        tools: m.tools,
        expires_at: m.expiresAt,
      });
      return { mandate: toProto(row) };
    },

    async revokeMandate({ mandateId }) {
      const row = await store.revokeMandate(mandateId);
      if (!row) throw new ConnectError(`no mandate ${mandateId}`, Code.NotFound);
      return { mandate: toProto(row) };
    },

    async listMandates({ agentId }) {
      const rows = await store.mandates(agentId ? { agentId } : {});
      return { mandates: rows.map(toProto) };
    },
  };
}
