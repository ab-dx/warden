// the payment guard workflow's input and result, shared by the gateway that starts
// it and the worker that runs it
export type GuardOutcome = 'allow' | 'escalate' | 'deny';
export type GuardReason = { code: string; message: string; check: string };

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
  outcome: GuardOutcome;
  reasons: GuardReason[];
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

export type GuardDecidedBy = 'policy' | 'human' | 'timeout';

export type GuardResult = {
  outcome: 'allow' | 'deny';
  reasons: GuardReason[];
  decidedBy: GuardDecidedBy;
  result?: Forwarded;
};

export type GuardEvent =
  | { kind: 'approvalRequested'; callId: string; reasons: GuardReason[]; expiresAt: string }
  | { kind: 'approvalResolved'; callId: string; approved: boolean; by: string }
  | {
      kind: 'decisionMade';
      callId: string;
      outcome: GuardOutcome;
      reasons: GuardReason[];
      decidedBy: GuardDecidedBy;
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
