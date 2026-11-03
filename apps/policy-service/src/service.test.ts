import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { PaymentIntentSchema, Tier } from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import { parsePolicyFile } from './engine/policy-file.js';
import { policyService, toIntent } from './service.js';

const intent = (over: object = {}) =>
  create(PaymentIntentSchema, {
    callId: 'c1',
    agentId: 'ops-agent',
    tool: 'send_payout',
    tier: Tier.MONEY_OUT,
    amount: { value: '40.00', currency: 'USD' },
    fingerprint: 'fp1',
    ...over,
  });

describe('toIntent', () => {
  it('reads amounts as exact minor units', () => {
    expect(toIntent(intent())).toMatchObject({ tier: 'T3', amountMinor: 4000n, currency: 'USD' });
  });

  it.each([
    [{ tier: Tier.UNSPECIFIED }, 'unknown tier'],
    [{ amount: { value: '4e1', currency: 'USD' } }, 'unreadable amount'],
    [{ callId: '' }, 'required'],
  ])('refuses bad intent %# (%s)', (over, msg) => {
    expect((toIntent(intent(over)) as { invalid: string }).invalid).toContain(msg);
  });
});

describe('createMandate', () => {
  const file = parsePolicyFile(`
agents:
  ops-agent:
    max_per_call: { value: "150.00", currency: USD }
    daily_budget: { value: "300.00", currency: USD }
    velocity: { max_calls: 3, per_seconds: 60, tiers: [T3] }
    duplicate_window_seconds: 300
`);
  const created: unknown[] = [];
  const svc = policyService(
    {
      createMandate: async (m: unknown) => {
        created.push(m);
        return {};
      },
    } as never,
    file,
  );
  const good = {
    agentId: 'ops-agent',
    userId: 'priya',
    task: 'pay contractors',
    maxPerCall: { value: '100.00', currency: 'USD' },
    maxTotal: { value: '200.00', currency: 'USD' },
    counterparties: ['dev@studio.example'],
    tools: ['send_payout'],
    expiresAt: timestampFromDate(new Date(Date.now() + 3_600_000)),
  };
  const call = (over: object) =>
    (svc.createMandate as (r: unknown) => Promise<unknown>)({ mandate: { ...good, ...over } });

  it.each([
    [{ agentId: 'stranger' }, 'no policy'],
    [{ maxPerCall: { value: '300.00', currency: 'USD' } }, 'no more than the total'],
    [{ maxTotal: { value: '200.00', currency: 'EUR' } }, 'share a currency'],
    [{ expiresAt: timestampFromDate(new Date(Date.now() - 1000)) }, 'future'],
    [{ expiresAt: timestampFromDate(new Date(Date.now() + 40 * 86_400_000)) }, '30 days'],
    [{ counterparties: ['x" || true'] }, 'counterparties'],
    [{ tools: [] }, 'tools'],
  ])('rejects bad mandate %# (%s)', async (over, msg) => {
    await expect(call(over)).rejects.toThrow(msg);
  });
});
