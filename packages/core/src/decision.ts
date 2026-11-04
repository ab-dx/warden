export type Outcome = 'allow' | 'escalate' | 'deny';
export type Reason = { code: string; message: string; check: string };
export type Verdict = { outcome: Outcome; reasons: Reason[] };

export type Check<C> = {
  name: string;
  run: (ctx: C) => Verdict | Promise<Verdict>;
};

const SEVERITY: Record<Outcome, number> = { allow: 0, escalate: 1, deny: 2 };

export const allow = (): Verdict => ({ outcome: 'allow', reasons: [] });

// the combined outcome can only move towards deny, so a later check (judge,
// provenance) can never loosen what an earlier one decided
export async function decide<C>(checks: readonly Check<C>[], ctx: C): Promise<Verdict> {
  if (checks.length === 0) {
    return deny('NO_CHECKS', 'no checks are configured for this call', 'decider');
  }
  let outcome: Outcome = 'allow';
  const reasons: Reason[] = [];
  for (const check of checks) {
    let v: Verdict;
    try {
      v = await check.run(ctx);
    } catch (err) {
      v = deny('CHECK_FAILED', `${check.name} failed: ${(err as Error).message}`, check.name);
    }
    if (!(v?.outcome in SEVERITY)) {
      v = deny('CHECK_FAILED', `${check.name} returned an invalid verdict`, check.name);
    }
    if (SEVERITY[v.outcome] > SEVERITY[outcome]) outcome = v.outcome;
    if (v.outcome !== 'allow') reasons.push(...v.reasons);
    // nothing after a deny can change the result, and later checks are the expensive ones
    if (outcome === 'deny') break;
  }
  return { outcome, reasons };
}

// folds another check's verdict into this one. the result is at least as strict as
// either, and the stricter verdict's reasons come first.
export function tighten(a: Verdict, b: Verdict): Verdict {
  const [hi, lo] = SEVERITY[b.outcome] > SEVERITY[a.outcome] ? [b, a] : [a, b];
  return {
    outcome: hi.outcome,
    reasons: [...hi.reasons, ...(lo.outcome === 'allow' ? [] : lo.reasons)],
  };
}

function deny(code: string, message: string, check: string): Verdict {
  return { outcome: 'deny', reasons: [{ code, message, check }] };
}
