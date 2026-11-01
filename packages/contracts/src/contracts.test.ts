import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import {
  type Event,
  EventSchema,
  Outcome,
  PaymentIntentSchema,
  PolicyService,
  Tier,
} from './index.js';

describe('contracts', () => {
  it('round-trips an event with its payload through the wire format', () => {
    const event = create(EventSchema, {
      eventId: 'evt_1',
      occurredAt: timestampNow(),
      aggregateType: 'call',
      aggregateId: 'c_1',
      producer: 'policy-service',
      payload: {
        case: 'decisionMade',
        value: {
          callId: 'c_1',
          outcome: Outcome.DENY,
          reasons: [{ code: 'COUNTERPARTY_NOT_IN_MANDATE', message: 'x', check: 'mandate' }],
        },
      },
    });
    const back: Event = fromBinary(EventSchema, toBinary(EventSchema, event));
    expect(back.payload.case).toBe('decisionMade');
    expect(back.payload.case === 'decisionMade' && back.payload.value.outcome).toBe(Outcome.DENY);
  });

  it('keeps money as a decimal string and tells an absent amount from zero', () => {
    const withAmount = create(PaymentIntentSchema, {
      tier: Tier.MONEY_OUT,
      amount: { value: '40.10', currency: 'USD' },
    });
    const back = fromBinary(PaymentIntentSchema, toBinary(PaymentIntentSchema, withAmount));
    expect(back.amount?.value).toBe('40.10');
    expect(
      fromBinary(PaymentIntentSchema, toBinary(PaymentIntentSchema, create(PaymentIntentSchema)))
        .amount,
    ).toBeUndefined();
  });

  it('exposes service descriptors for connect', () => {
    expect(Object.keys(PolicyService.method)).toContain('evaluateAndReserve');
  });
});
