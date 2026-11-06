import { create } from '@bufbuild/protobuf';
import {
  ApprovalResolvedSchema,
  CallReceivedSchema,
  DecidedBy,
  DecisionMadeSchema,
  EventSchema,
  Outcome,
  PaymentExecutedSchema,
} from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import { sample } from './metrics.js';

describe('sample', () => {
  it('labels a decision by outcome and by who decided', () => {
    const value = create(DecisionMadeSchema, {
      callId: 'c1',
      outcome: Outcome.ESCALATE,
      decidedBy: DecidedBy.JUDGE,
    });
    expect(sample(create(EventSchema, { payload: { case: 'decisionMade', value } }))).toEqual({
      metric: 'decisions',
      attrs: { outcome: 'escalate', decided_by: 'judge' },
    });
  });

  it('says where an approval came from, and labels paypal results', () => {
    const approved = create(ApprovalResolvedSchema, { approved: true, resolvedBy: 'telegram:42' });
    expect(
      sample(create(EventSchema, { payload: { case: 'approvalResolved', value: approved } }))
        ?.attrs,
    ).toEqual({ approved: 'true', via: 'telegram' });
    const paid = create(PaymentExecutedSchema, {
      tool: 'create_refund',
      ok: false,
      errorCode: 'PAYPAL_API_HTTP_ERROR',
    });
    expect(
      sample(create(EventSchema, { payload: { case: 'paymentExecuted', value: paid } }))?.attrs,
    ).toEqual({ tool: 'create_refund', ok: 'false', error: 'PAYPAL_API_HTTP_ERROR' });
  });

  it('ignores events it does not count', () => {
    const value = create(CallReceivedSchema, {});
    expect(
      sample(create(EventSchema, { payload: { case: 'callReceived', value } })),
    ).toBeUndefined();
  });
});
