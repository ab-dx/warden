import { createHash } from 'node:crypto';
import { create, fromJson, type JsonObject } from '@bufbuild/protobuf';
import { timestampFromDate, timestampNow } from '@bufbuild/protobuf/wkt';
import type { Client } from '@connectrpc/connect';
import type {
  Evaluation,
  Forwarded,
  GuardEvent,
  GuardInput,
  GuardReason,
  Json,
} from '@warden/contracts';
import {
  type ConnectorService,
  DecidedBy,
  EventSchema,
  type JudgeService,
  MandateStatus,
  Outcome,
  PaymentIntentSchema,
  type PolicyService,
} from '@warden/contracts';
import type { Outcome as CoreOutcome } from '@warden/core';
import { enqueue } from '@warden/outbox';
import type { Pool } from 'pg';

export type Deps = {
  policy: Client<typeof PolicyService>;
  connector: Client<typeof ConnectorService>;
  // without a judge, payments are decided by policy alone
  judge?: Client<typeof JudgeService> | undefined;
  pool: Pool;
};

const OUTCOME_FROM_PROTO: Partial<Record<Outcome, CoreOutcome>> = {
  [Outcome.ALLOW]: 'allow',
  [Outcome.ESCALATE]: 'escalate',
  [Outcome.DENY]: 'deny',
};
const OUTCOME_TO_PROTO: Record<CoreOutcome, Outcome> = {
  allow: Outcome.ALLOW,
  escalate: Outcome.ESCALATE,
  deny: Outcome.DENY,
};
const DECIDED_BY = {
  policy: DecidedBy.POLICY,
  judge: DecidedBy.JUDGE,
  human: DecidedBy.HUMAN,
  timeout: DecidedBy.TIMEOUT,
};

const intentOf = (input: { intent: GuardInput['intent'] }) =>
  fromJson(PaymentIntentSchema, input.intent);

// same call and kind always give the same id, so a retried emit is a no-op in the outbox
export function eventId(callId: string, kind: string): string {
  const h = createHash('sha256').update(`${callId}:${kind}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createActivities({ policy, connector, judge, pool }: Deps) {
  return {
    // provenance runs before policy so a call it holds never draws on the mandate
    async assess(input: GuardInput): Promise<Evaluation> {
      if (!judge) return { outcome: 'allow', reasons: [] };
      const intent = intentOf(input);
      const { mandates } = await policy.listMandates({ agentId: intent.agentId });
      const res = await judge.assess({
        intent,
        mandates: mandates.filter((m) => m.status === MandateStatus.ACTIVE),
      });
      const outcome = OUTCOME_FROM_PROTO[res.outcome];
      if (!outcome) {
        return {
          outcome: 'deny',
          reasons: [{ code: 'CHECK_FAILED', message: 'judge returned no outcome', check: 'judge' }],
        };
      }
      return {
        outcome,
        reasons: res.reasons.map(({ code, message, check }) => ({ code, message, check })),
      };
    },

    async evaluate(input: GuardInput, escalations: GuardReason[] = []): Promise<Evaluation> {
      const res = await policy.evaluateAndReserve({ intent: intentOf(input), escalations });
      const outcome = OUTCOME_FROM_PROTO[res.outcome];
      if (!outcome) {
        return {
          outcome: 'deny',
          reasons: [
            { code: 'CHECK_FAILED', message: 'policy returned no outcome', check: 'policy' },
          ],
        };
      }
      return {
        outcome,
        reasons: res.reasons.map(({ code, message, check }) => ({ code, message, check })),
        reservationId: res.reservationId,
        mandateId: res.mandateId,
      };
    },

    async forward(input: GuardInput): Promise<Forwarded> {
      // keyed by call, not by fingerprint: two legitimate identical payouts must both go
      // through, and repeats across calls are the duplicate rule's job
      const res = await connector.callTool({
        callId: input.callId,
        tool: input.tool,
        arguments: input.args as JsonObject,
        idempotencyKey: input.callId,
      });
      return {
        ok: res.ok,
        content: res.content as Json[],
        upstreamRef: res.upstreamRef,
        errorCode: res.errorCode,
      };
    },

    async settle(reservationId: string, intentJson: GuardInput['intent'], upstreamRef: string) {
      const { amount } = intentOf({ intent: intentJson });
      await policy.settleReservation({
        reservationId,
        upstreamRef,
        ...(amount ? { settled: amount } : {}),
      });
    },

    async release(reservationId: string, reason: string) {
      await policy.releaseReservation({ reservationId, reason });
    },

    async emit(e: GuardEvent) {
      const event = create(EventSchema, {
        eventId: eventId(e.callId, e.kind),
        occurredAt: timestampNow(),
        aggregateType: 'call',
        aggregateId: e.callId,
        producer: 'guard-worker',
        payload: toPayload(e),
      });
      const tx = await pool.connect();
      try {
        await tx.query('begin');
        await enqueue(tx, event);
        await tx.query('commit');
      } catch (err) {
        await tx.query('rollback').catch(() => {});
        throw err;
      } finally {
        tx.release();
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

function toPayload(e: GuardEvent) {
  switch (e.kind) {
    case 'approvalRequested':
      return {
        case: e.kind,
        value: {
          callId: e.callId,
          approvalId: e.callId,
          reasons: e.reasons,
          expiresAt: timestampFromDate(new Date(e.expiresAt)),
        },
      } as const;
    case 'approvalResolved':
      return {
        case: e.kind,
        value: { callId: e.callId, approvalId: e.callId, approved: e.approved, resolvedBy: e.by },
      } as const;
    case 'decisionMade':
      return {
        case: e.kind,
        value: {
          callId: e.callId,
          outcome: OUTCOME_TO_PROTO[e.outcome],
          reasons: e.reasons,
          decidedBy: DECIDED_BY[e.decidedBy],
          mandateId: e.mandateId,
          reservationId: e.reservationId,
        },
      } as const;
    case 'paymentExecuted':
      return {
        case: e.kind,
        value: {
          callId: e.callId,
          tool: e.tool,
          ok: e.ok,
          upstreamRef: e.upstreamRef,
          errorCode: e.errorCode,
        },
      } as const;
    case 'reservationReleased':
      return {
        case: e.kind,
        value: { callId: e.callId, reservationId: e.reservationId, reason: e.reason },
      } as const;
  }
}
