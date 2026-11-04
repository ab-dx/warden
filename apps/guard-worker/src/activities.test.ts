import { MandateStatus, Outcome } from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import { createActivities, eventId } from './activities.js';

const input = {
  callId: 'c_0f1e2d3c4b5a',
  tool: 'send_payout',
  args: { receiver_email: 'a@b.co' },
  intent: {
    callId: 'c1',
    fingerprint: 'fp_0123456789',
    amount: { value: '120.00', currency: 'USD' },
  },
};

function activities(policyOutcome: Outcome, judgeOutcome?: Outcome) {
  const seen: Record<string, unknown> = {};
  const acts = createActivities({
    judge:
      judgeOutcome !== undefined
        ? ({
            assess: async (req: unknown) => {
              seen.assess = req;
              return { outcome: judgeOutcome, reasons: [] };
            },
          } as never)
        : undefined,
    policy: {
      listMandates: async () => ({
        mandates: [
          { id: 'm1', status: MandateStatus.ACTIVE },
          { id: 'm2', status: MandateStatus.REVOKED },
        ],
      }),
      evaluateAndReserve: async () => ({
        outcome: policyOutcome,
        reasons: [],
        reservationId: 'r1',
      }),
      settleReservation: async (req: unknown) => {
        seen.settle = req;
      },
    } as never,
    connector: {
      callTool: async (req: unknown) => {
        seen.callTool = req;
        return { ok: true, content: [], upstreamRef: 'B1' };
      },
    } as never,
    pool: {} as never,
  });
  return { acts, seen };
}

describe('activities', () => {
  it('maps policy outcomes and treats a missing one as deny', async () => {
    expect((await activities(Outcome.ESCALATE).acts.evaluate(input)).outcome).toBe('escalate');
    const r = await activities(Outcome.UNSPECIFIED).acts.evaluate(input);
    expect(r).toMatchObject({ outcome: 'deny', reasons: [{ code: 'CHECK_FAILED' }] });
  });

  it('runs provenance against active mandates only, and allows when no judge is set', async () => {
    expect(await activities(Outcome.ALLOW).acts.assess(input)).toEqual({
      outcome: 'allow',
      reasons: [],
    });
    const { acts, seen } = activities(Outcome.ALLOW, Outcome.ESCALATE);
    expect((await acts.assess(input)).outcome).toBe('escalate');
    expect((seen.assess as { mandates: { id: string }[] }).mandates.map((m) => m.id)).toEqual([
      'm1',
    ]);
    const broken = activities(Outcome.ALLOW, Outcome.UNSPECIFIED).acts;
    expect(await broken.assess(input)).toMatchObject({ outcome: 'deny' });
  });

  it('forwards with the call id as the idempotency key, not the fingerprint', async () => {
    const { acts, seen } = activities(Outcome.ALLOW);
    await acts.forward(input);
    expect(seen.callTool).toMatchObject({ tool: 'send_payout', idempotencyKey: 'c_0f1e2d3c4b5a' });
  });

  it('settles with the intended amount', async () => {
    const { acts, seen } = activities(Outcome.ALLOW);
    await acts.settle('r1', input.intent, 'B1');
    expect(seen.settle).toMatchObject({
      reservationId: 'r1',
      settled: { value: '120.00' },
      upstreamRef: 'B1',
    });
  });

  it('derives stable, distinct, uuid-shaped event ids', () => {
    expect(eventId('c1', 'decisionMade')).toBe(eventId('c1', 'decisionMade'));
    expect(eventId('c1', 'decisionMade')).not.toBe(eventId('c1', 'paymentExecuted'));
    expect(eventId('c1', 'x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
