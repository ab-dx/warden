import { describe, expect, it } from 'vitest';
import { allow, type Check, decide, type Verdict } from './decision.js';

const verdict = (outcome: Verdict['outcome'], code = 'X'): Verdict => ({
  outcome,
  reasons: outcome === 'allow' ? [] : [{ code, message: code, check: 'test' }],
});
const check = (name: string, v: Verdict | (() => never)): Check<unknown> => ({
  name,
  run: typeof v === 'function' ? v : () => v,
});

describe('decide', () => {
  it('allows when every check allows', async () => {
    expect(await decide([check('a', allow()), check('b', allow())], {})).toEqual(allow());
  });

  it('takes the most severe outcome and keeps the reasons', async () => {
    const r = await decide([check('a', verdict('escalate', 'NEW_PAYEE')), check('b', allow())], {});
    expect(r.outcome).toBe('escalate');
    expect(r.reasons.map((x) => x.code)).toEqual(['NEW_PAYEE']);
  });

  it('a later allow cannot loosen an earlier escalate', async () => {
    const r = await decide([check('policy', verdict('escalate')), check('judge', allow())], {});
    expect(r.outcome).toBe('escalate');
  });

  it('stops at the first deny', async () => {
    let judged = false;
    const judge: Check<unknown> = {
      name: 'judge',
      run: () => {
        judged = true;
        return allow();
      },
    };
    const r = await decide([check('policy', verdict('deny', 'OVER_CAP')), judge], {});
    expect(r.outcome).toBe('deny');
    expect(judged).toBe(false);
  });

  it('fails closed when a check throws', async () => {
    const r = await decide(
      [
        check('ok', allow()),
        check('judge', () => {
          throw new Error('timeout');
        }),
      ],
      {},
    );
    expect(r.outcome).toBe('deny');
    expect(r.reasons[0]).toMatchObject({ code: 'CHECK_FAILED', check: 'judge' });
  });

  it('fails closed on a malformed verdict or no checks at all', async () => {
    const bad = { name: 'bad', run: () => ({ outcome: 'maybe' }) as unknown as Verdict };
    expect((await decide([bad], {})).outcome).toBe('deny');
    expect((await decide([], {})).reasons[0]?.code).toBe('NO_CHECKS');
  });
});
