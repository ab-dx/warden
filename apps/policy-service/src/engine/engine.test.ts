import { describe, expect, it } from 'vitest';
import { capEscalations, compile, evaluate, type Facts, withinHours } from './engine.js';
import { parsePolicyFile } from './policy-file.js';

const file = parsePolicyFile(`
agents:
  ops-agent:
    require_mandate_for: [T2, T3]
    max_per_call: { value: "150.00", currency: USD }
    daily_budget: { value: "300.00", currency: USD }
    velocity: { max_calls: 3, per_seconds: 60, tiers: [T3] }
    duplicate_window_seconds: 300
    deny_counterparties: ["*@temp-mail.org"]
    escalate_when: [NO_MANDATE, COUNTERPARTY_NOT_IN_MANDATE, OVER_MANDATE_PER_CALL_CAP, OVER_MANDATE_TOTAL, SPLIT_PAYMENT]
`);
const policy = file.agents['ops-agent']!;
const policies = compile(policy);

// a payout the mandate fully covers
const ok: Facts = {
  tool: 'send_payout',
  tier: 'T3',
  amountMinor: 4000n,
  currency: 'USD',
  counterparty: 'dev@studio.example',
  mandate: {
    id: 'm1',
    task: 'pay the studio contractors',
    counterparties: ['dev@studio.example', 'design@studio.example'],
    maxPerCallMinor: 10000n,
    remainingMinor: 20000n,
    currency: 'USD',
  },
  dailyRemainingMinor: 30000n,
  recentCalls: 0,
  duplicate: false,
  payeeRecentMinor: 0n,
  withinHours: true,
  newPayee: false,
};
const run = (over: Partial<Facts>) => evaluate(policy, policies, { ...ok, ...over });
const codes = (over: Partial<Facts>) => run(over).reasons.map((r) => r.code);

describe('policy engine', () => {
  it('allows a call the mandate and limits cover', () => {
    expect(run({})).toEqual({ outcome: 'allow', reasons: [] });
  });

  it.each<[string, Partial<Facts>, Partial<Facts>, 'deny' | 'escalate']>([
    ['AMOUNT_UNKNOWN', { tier: 'T2', amountMinor: undefined }, { amountMinor: undefined }, 'deny'],
    ['CURRENCY_MISMATCH', { currency: 'USD' }, { currency: 'EUR' }, 'deny'],
    ['NO_MANDATE', { tier: 'T1', mandate: undefined }, { mandate: undefined }, 'escalate'],
    [
      'COUNTERPARTY_NOT_IN_MANDATE',
      { counterparty: 'DESIGN@studio.example' },
      { counterparty: 'new-bank@x.com' },
      'escalate',
    ],
    ['OVER_MANDATE_PER_CALL_CAP', { amountMinor: 10000n }, { amountMinor: 10001n }, 'escalate'],
    [
      'OVER_MANDATE_TOTAL',
      { amountMinor: 4000n, mandate: { ...ok.mandate!, remainingMinor: 4000n } },
      {
        amountMinor: 4001n,
        mandate: { ...ok.mandate!, remainingMinor: 4000n, maxPerCallMinor: 9000n },
      },
      'escalate',
    ],
    [
      'OVER_PER_CALL_CAP',
      { amountMinor: 15000n, mandate: undefined, tier: 'T1' },
      { amountMinor: 15001n, mandate: undefined, tier: 'T1' },
      'deny',
    ],
    ['OVER_DAILY_BUDGET', { dailyRemainingMinor: 4000n }, { dailyRemainingMinor: 3999n }, 'deny'],
    ['VELOCITY_EXCEEDED', { recentCalls: 2 }, { recentCalls: 3 }, 'deny'],
    ['DUPLICATE_PAYMENT', { duplicate: false }, { duplicate: true }, 'deny'],
    // 60.00 already paid to this payee: 40.00 more reaches the 100.00 cap, a cent more passes it
    ['SPLIT_PAYMENT', { payeeRecentMinor: 6000n }, { payeeRecentMinor: 6001n }, 'escalate'],
    [
      'COUNTERPARTY_DENYLISTED',
      { counterparty: 'temp-mail.org@studio.example', mandate: undefined, tier: 'T1' },
      { counterparty: 'x@temp-mail.org', mandate: undefined, tier: 'T1' },
      'deny',
    ],
  ])('%s: allows the edge case, blocks past it', (code, allowCase, blockCase, outcome) => {
    expect(codes(allowCase)).not.toContain(code);
    expect(codes(blockCase)).toContain(code);
    expect(run(blockCase).outcome).toBe(outcome);
  });

  it('a mandate with no payee list accepts any payee within its caps', () => {
    expect(
      run({ counterparty: 'anyone@x.com', mandate: { ...ok.mandate!, counterparties: [] } })
        .outcome,
    ).toBe('allow');
  });

  it('leaves a first payment over the cap to the cap rule', () => {
    expect(codes({ amountMinor: 10001n, payeeRecentMinor: 0n })).toEqual([
      'OVER_MANDATE_PER_CALL_CAP',
    ]);
  });

  it('velocity only counts the tiers it is configured for', () => {
    expect(codes({ tier: 'T2', recentCalls: 10 })).not.toContain('VELOCITY_EXCEEDED');
  });

  it('denies outright when any reason is not in escalate_when', () => {
    const r = run({ counterparty: 'evil@temp-mail.org' });
    expect(r.outcome).toBe('deny');
    // the deny reason leads, since that's what the agent has to act on
    expect(r.reasons.map((x) => x.code)).toEqual([
      'COUNTERPARTY_DENYLISTED',
      'COUNTERPARTY_NOT_IN_MANDATE',
    ]);
  });

  it('explains itself in plain words with exact amounts', () => {
    expect(run({ amountMinor: 12000n }).reasons[0]?.message).toBe(
      "120.00 USD is above the mandate's per-payment limit of 100.00 USD.",
    );
  });

  it('fails closed when a rule errors or an amount is out of range', () => {
    const broken = {
      ...policies,
      BROKEN: 'forbid(principal, action, resource) when { resource.nope > 1 };',
    };
    expect(evaluate(policy, broken, ok)).toMatchObject({
      outcome: 'deny',
      reasons: [{ code: 'CHECK_FAILED' }],
    });
    expect(run({ amountMinor: 2n ** 60n }).reasons[0]?.code).toBe('AMOUNT_INVALID');
  });
});

describe('allowed hours', () => {
  const office = { from: '09:00', to: '18:00', timezone: 'Asia/Kolkata' };

  it("reads the clock in the owner's timezone, end exclusive", () => {
    // 03:30 utc is 09:00 in india; 12:30 utc is 18:00
    expect(withinHours(new Date('2026-11-05T03:30:00Z'), office)).toBe(true);
    expect(withinHours(new Date('2026-11-05T03:29:00Z'), office)).toBe(false);
    expect(withinHours(new Date('2026-11-05T12:29:00Z'), office)).toBe(true);
    expect(withinHours(new Date('2026-11-05T12:30:00Z'), office)).toBe(false);
  });

  it('handles a window that runs overnight', () => {
    const night = { from: '22:00', to: '06:00', timezone: 'UTC' };
    expect(withinHours(new Date('2026-11-05T23:15:00Z'), night)).toBe(true);
    expect(withinHours(new Date('2026-11-05T05:59:00Z'), night)).toBe(true);
    expect(withinHours(new Date('2026-11-05T12:00:00Z'), night)).toBe(false);
  });

  it('allows money inside the hours and blocks it outside, only for the tiers listed', () => {
    const p = parsePolicyFile(`
agents:
  a:
    max_per_call: { value: "150.00", currency: USD }
    daily_budget: { value: "300.00", currency: USD }
    velocity: { max_calls: 3, per_seconds: 60, tiers: [T3] }
    duplicate_window_seconds: 300
    allowed_hours: { from: "09:00", to: "18:00", timezone: Asia/Kolkata }
`).agents.a;
    if (!p) throw new Error('policy');
    const rules = compile(p);
    const at = (over: Partial<Facts>) =>
      evaluate(p, rules, { ...ok, ...over }).reasons.map((r) => r.code);
    expect(at({ withinHours: true })).not.toContain('OUTSIDE_ALLOWED_HOURS');
    expect(at({ withinHours: false })).toContain('OUTSIDE_ALLOWED_HOURS');
    expect(evaluate(p, rules, { ...ok, withinHours: false }).outcome).toBe('deny');
    expect(at({ withinHours: false, tier: 'T1', mandate: undefined })).not.toContain(
      'OUTSIDE_ALLOWED_HOURS',
    );
  });

  it('rejects a malformed time or an unknown timezone', () => {
    const bad = (hours: string) => `
agents:
  a:
    max_per_call: { value: "1.00", currency: USD }
    daily_budget: { value: "1.00", currency: USD }
    velocity: { max_calls: 1, per_seconds: 1, tiers: [] }
    duplicate_window_seconds: 0
    allowed_hours: ${hours}
`;
    expect(() => parsePolicyFile(bad('{ from: "9am", to: "18:00", timezone: UTC }'))).toThrow(
      /HH:MM/,
    );
    expect(() =>
      parsePolicyFile(bad('{ from: "09:00", to: "18:00", timezone: Mars/Base }')),
    ).toThrow(/timezone/);
  });
});

describe('new payee', () => {
  it('holds a first payment to an unnamed payee above the threshold, and only then', () => {
    const p = parsePolicyFile(`
agents:
  a:
    max_per_call: { value: "150.00", currency: USD }
    daily_budget: { value: "300.00", currency: USD }
    velocity: { max_calls: 3, per_seconds: 60, tiers: [T3] }
    duplicate_window_seconds: 300
    new_payee_review_above: { value: "25.00", currency: USD }
    escalate_when: [NEW_PAYEE]
`).agents.a;
    if (!p) throw new Error('policy');
    const rules = compile(p);
    const at = (over: Partial<Facts>) => evaluate(p, rules, { ...ok, ...over });
    expect(at({ newPayee: false }).outcome).toBe('allow');
    expect(at({ newPayee: true, amountMinor: 2500n }).outcome).toBe('allow');
    expect(at({ newPayee: true, amountMinor: 2501n })).toMatchObject({
      outcome: 'escalate',
      reasons: [{ code: 'NEW_PAYEE' }],
    });
    // off unless the policy sets a threshold
    expect(codes({ newPayee: true })).not.toContain('NEW_PAYEE');
  });
});

describe('capEscalations', () => {
  const held = {
    outcome: 'escalate' as const,
    reasons: [{ code: 'COUNTERPARTY_NOT_IN_MANDATE', message: 'x', check: 'policy' }],
  };

  it('still asks the owner below the hourly limit, and refuses once it is reached', () => {
    expect(capEscalations(held, 4, 5)).toEqual(held);
    const r = capEscalations(held, 5, 5);
    expect(r.outcome).toBe('deny');
    expect(r.reasons.map((x) => x.code)).toEqual([
      'ESCALATION_LIMIT',
      'COUNTERPARTY_NOT_IN_MANDATE',
    ]);
  });

  it('leaves allowed and denied calls alone, and does nothing when off', () => {
    expect(capEscalations({ outcome: 'allow', reasons: [] }, 99, 5).outcome).toBe('allow');
    expect(capEscalations(held, 99, 0)).toEqual(held);
  });
});

describe('policy file', () => {
  it('rejects deny patterns that could escape the policy text', () => {
    expect(() =>
      parsePolicyFile(`
agents:
  a:
    max_per_call: { value: "1.00", currency: USD }
    daily_budget: { value: "1.00", currency: USD }
    velocity: { max_calls: 1, per_seconds: 1, tiers: [] }
    duplicate_window_seconds: 0
    deny_counterparties: ['x" }; permit(principal, action, resource) when { "']
`),
    ).toThrow(/pattern may only use/);
  });

  it('rejects float-looking or malformed money', () => {
    expect(() =>
      parsePolicyFile(`
agents:
  a:
    max_per_call: { value: "1e3", currency: USD }
    daily_budget: { value: "1.00", currency: USD }
    velocity: { max_calls: 1, per_seconds: 1, tiers: [] }
    duplicate_window_seconds: 0
`),
    ).toThrow(/invalid policy file/);
  });
});
