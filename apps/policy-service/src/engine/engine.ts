import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { fromMinor, type Outcome, type Reason } from '@warden/core';
import type { AgentPolicy } from './policy-file.js';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

// everything the rules look at, gathered by the store from the intent and the ledger of holds
export type Facts = {
  tool: string;
  tier: Tier;
  amountMinor?: bigint | undefined;
  currency?: string | undefined;
  counterparty?: string | undefined;
  mandate?:
    | {
        id: string;
        counterparties: string[];
        maxPerCallMinor: bigint;
        remainingMinor: bigint;
        currency: string;
      }
    | undefined;
  dailyRemainingMinor: bigint;
  recentCalls: number;
  duplicate: boolean;
  // live payments to this payee in the split window, not counting this one
  payeeRecentMinor: bigint;
};

export type Verdict = { outcome: Outcome; reasons: Reason[] };

const forbid = (when: string) => `forbid(principal, action, resource) when { ${when} };`;

// each policy id is the reason code it reports. facts arrive as context, so nothing
// user-supplied is ever pasted into policy text.
export function compile(policy: AgentPolicy): Record<string, string> {
  const policies: Record<string, string> = {
    BASE: 'permit(principal, action, resource);',
    AMOUNT_UNKNOWN: forbid('context.tier == "T3" && !(resource has amount)'),
    CURRENCY_MISMATCH: forbid('context.currency_mismatch'),
    NO_MANDATE: forbid('context.requires_mandate && !context.has_mandate'),
    COUNTERPARTY_NOT_IN_MANDATE: forbid(
      'context.has_mandate && context.mandate_restricts_counterparty && ' +
        '(!(resource has counterparty) || !context.mandate_counterparties.contains(resource.counterparty))',
    ),
    OVER_MANDATE_PER_CALL_CAP: forbid(
      'context.has_mandate && resource has amount && resource.amount > context.mandate_max_per_call',
    ),
    OVER_MANDATE_TOTAL: forbid(
      'context.has_mandate && resource has amount && resource.amount > context.mandate_remaining',
    ),
    OVER_PER_CALL_CAP: forbid('resource has amount && resource.amount > context.max_per_call'),
    OVER_DAILY_BUDGET: forbid('resource has amount && resource.amount > context.daily_remaining'),
    VELOCITY_EXCEEDED: forbid(
      'context.velocity_applies && context.recent_calls >= context.velocity_max',
    ),
    DUPLICATE_PAYMENT: forbid('context.duplicate'),
    // several payments to one payee that together pass the per-payment cap look like one
    // payment split up to get under it. the first payment is left to the cap itself
    SPLIT_PAYMENT: forbid(
      'context.has_mandate && resource has amount && context.payee_recent > 0 && ' +
        'context.payee_recent + resource.amount > context.mandate_max_per_call',
    ),
  };
  policy.deny_counterparties.forEach((p, i) => {
    policies[`COUNTERPARTY_DENYLISTED#${i}`] = forbid(
      `resource has counterparty && resource.counterparty like "${p}"`,
    );
  });
  return policies;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function evaluate(policy: AgentPolicy, policies: Record<string, string>, f: Facts): Verdict {
  const amounts = [
    f.amountMinor,
    f.mandate?.remainingMinor,
    f.dailyRemainingMinor,
    f.payeeRecentMinor,
  ];
  if (amounts.some((a) => a !== undefined && (a > MAX_SAFE || a < -MAX_SAFE))) {
    return deny('AMOUNT_INVALID', 'the amount is outside the range warden can check', 'policy');
  }
  const limitCurrency = policy.max_per_call.currency;
  const currencyMismatch =
    f.amountMinor !== undefined &&
    (f.currency !== limitCurrency ||
      (f.mandate !== undefined && f.mandate.currency !== f.currency));

  const resource: Record<string, string | number> = { tool: f.tool };
  if (f.amountMinor !== undefined) resource.amount = Number(f.amountMinor);
  if (f.counterparty !== undefined) resource.counterparty = f.counterparty.toLowerCase();

  const res = cedar.isAuthorized({
    principal: { type: 'Agent', id: 'agent' },
    action: { type: 'Action', id: f.tool },
    resource: { type: 'Payment', id: 'call' },
    context: {
      tier: f.tier,
      currency_mismatch: currencyMismatch,
      requires_mandate: policy.require_mandate_for.includes(f.tier),
      has_mandate: f.mandate !== undefined,
      mandate_restricts_counterparty: (f.mandate?.counterparties.length ?? 0) > 0,
      mandate_counterparties: (f.mandate?.counterparties ?? []).map((c) => c.toLowerCase()),
      mandate_max_per_call: Number(f.mandate?.maxPerCallMinor ?? 0n),
      mandate_remaining: Number(f.mandate?.remainingMinor ?? 0n),
      max_per_call: Number(policy.max_per_call.minor),
      daily_remaining: Number(f.dailyRemainingMinor),
      velocity_applies: policy.velocity.tiers.includes(f.tier),
      recent_calls: f.recentCalls,
      velocity_max: policy.velocity.max_calls,
      duplicate: f.duplicate,
      payee_recent: Number(f.payeeRecentMinor),
    },
    policies: { staticPolicies: policies },
    entities: [{ uid: { type: 'Payment', id: 'call' }, attrs: resource, parents: [] }],
  });

  // cedar skips a policy that errors and may then allow, so any error is a deny here
  if (res.type !== 'success' || res.response.diagnostics.errors.length > 0) {
    return deny('CHECK_FAILED', 'the policy engine could not evaluate this call', 'policy');
  }
  const codes = res.response.diagnostics.reason
    .filter((id) => id !== 'BASE')
    .map((id) => id.split('#')[0] as string);
  if (res.response.decision === 'allow') return { outcome: 'allow', reasons: [] };
  if (codes.length === 0) return deny('CHECK_FAILED', 'denied without a reason', 'policy');

  // the reasons that deny outright come first, since they are what the agent must act on
  const escalates = (c: string) => policy.escalate_when.includes(c);
  const unique = [...new Set(codes)].sort((a, b) => Number(escalates(a)) - Number(escalates(b)));
  const reasons = unique.map((code) => ({ code, message: message(code, f), check: 'policy' }));
  const outcome = unique.every(escalates) ? 'escalate' : 'deny';
  return { outcome, reasons };
}

// an agent that keeps asking can wear the owner down until they tap approve without reading.
// past the hourly limit a payment that would be held is refused instead, so the owner only
// ever sees a handful at a time. runs last, after every check's holds are in.
export function capEscalations(v: Verdict, heldThisHour: number, max: number): Verdict {
  if (v.outcome !== 'escalate' || max === 0 || heldThisHour < max) return v;
  return {
    outcome: 'deny',
    reasons: [
      {
        code: 'ESCALATION_LIMIT',
        message: `${max} payments already needed the user's approval this hour. Wait before asking again.`,
        check: 'policy',
      },
      ...v.reasons,
    ],
  };
}

function deny(code: string, message: string, check: string): Verdict {
  return { outcome: 'deny', reasons: [{ code, message, check }] };
}

const fmt = (minor: bigint | undefined, currency: string | undefined) => {
  if (minor === undefined || !currency) return 'an unknown amount';
  try {
    return `${fromMinor(minor < 0n ? 0n : minor, currency).value} ${currency}`;
  } catch {
    return 'an unknown amount';
  }
};

function message(code: string, f: Facts): string {
  const who = f.counterparty ?? 'this payee';
  const amt = fmt(f.amountMinor, f.currency);
  switch (code) {
    case 'AMOUNT_UNKNOWN':
      return `${f.tool} moves money but the amount could not be determined.`;
    case 'CURRENCY_MISMATCH':
      return `The payment currency ${f.currency ?? ''} does not match the authorised limits.`;
    case 'NO_MANDATE':
      return `No active mandate covers ${f.tool}. Ask the user to grant one.`;
    case 'COUNTERPARTY_NOT_IN_MANDATE':
      return `Payment to ${who} is not covered by your mandate. Ask the user to approve or add this payee.`;
    case 'OVER_MANDATE_PER_CALL_CAP':
      return `${amt} is above the mandate's per-payment limit of ${fmt(f.mandate?.maxPerCallMinor, f.currency)}.`;
    case 'OVER_MANDATE_TOTAL':
      return `${amt} would exceed what is left on the mandate (${fmt(f.mandate?.remainingMinor, f.currency)}).`;
    case 'OVER_PER_CALL_CAP':
      return `${amt} is above the per-payment limit for this agent.`;
    case 'OVER_DAILY_BUDGET':
      return `${amt} would exceed today's remaining budget of ${fmt(f.dailyRemainingMinor, f.currency)}.`;
    case 'VELOCITY_EXCEEDED':
      return 'Too many payments in a short time. Wait before trying again.';
    case 'DUPLICATE_PAYMENT':
      return `An identical payment to ${who} was made moments ago. This looks like a repeat.`;
    case 'SPLIT_PAYMENT':
      return `${amt} to ${who} would bring recent payments to them to ${fmt(f.payeeRecentMinor + (f.amountMinor ?? 0n), f.currency)}, above the mandate's per-payment limit of ${fmt(f.mandate?.maxPerCallMinor, f.currency)}. This looks like one payment split up.`;
    case 'COUNTERPARTY_DENYLISTED':
      return `${who} is on the deny list.`;
    default:
      return code;
  }
}
