import type { Outcome, Reason } from '@warden/core';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type GuardInput = {
  callId: string;
  tool: string;
  args: { [k: string]: Json };
  // protobuf json of warden.v1.PaymentIntent, opaque to the workflow
  intent: { [k: string]: Json };
  approvalTimeoutMs?: number;
};

export type Evaluation = {
  outcome: Outcome;
  reasons: Reason[];
  reservationId?: string | undefined;
  mandateId?: string | undefined;
};

export type Forwarded = {
  ok: boolean;
  content: Json[];
  upstreamRef?: string | undefined;
  errorCode?: string | undefined;
};

export type Decision = { approved: boolean; by: string };

export type DecidedBy = 'policy' | 'human' | 'timeout';

export type GuardResult = {
  outcome: 'allow' | 'deny';
  reasons: Reason[];
  decidedBy: DecidedBy;
  result?: Forwarded;
};

export type GuardEvent =
  | { kind: 'approvalRequested'; callId: string; reasons: Reason[]; expiresAt: string }
  | { kind: 'approvalResolved'; callId: string; approved: boolean; by: string }
  | {
      kind: 'decisionMade';
      callId: string;
      outcome: Outcome;
      reasons: Reason[];
      decidedBy: DecidedBy;
      mandateId?: string | undefined;
      reservationId?: string | undefined;
    }
  | {
      kind: 'paymentExecuted';
      callId: string;
      tool: string;
      ok: boolean;
      upstreamRef?: string | undefined;
      errorCode?: string | undefined;
    }
  | { kind: 'reservationReleased'; callId: string; reservationId: string; reason: string };
