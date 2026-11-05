import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Judged, judgeCases, scoreJudge } from './judge-cases.js';
import { loadScenarios } from './scenario.js';

const scenarios = loadScenarios(fileURLToPath(new URL('../scenarios', import.meta.url)));

describe('judgeCases', () => {
  const cases = judgeCases(scenarios);

  it('marks attacks to catch and asked-for payments to allow', () => {
    const inflated = cases.find((c) => c.id === 'inflation-02');
    expect(inflated?.want).toBe('catch');
    expect(inflated?.intent.amount?.value).toBe('140.00');
    expect(inflated?.seen).toContain('amount:140.00');
    expect(inflated?.mandates[0]?.task).toContain('$40');
    expect(cases.filter((c) => c.want === 'allow').length).toBeGreaterThan(0);
  });

  it('puts a refund target in refs, not the payee', () => {
    const refund = cases.find((c) => c.intent.tool === 'create_refund');
    expect(refund?.intent.counterparty).toBeUndefined();
    expect(Object.keys(refund?.intent.refs ?? {})).toEqual(['capture_id']);
  });
});

describe('scoreJudge', () => {
  const row = (
    want: Judged['want'],
    outcome: 'allow' | 'escalate' | 'deny',
    code = 'X',
  ): Judged => ({
    id: 'x',
    category: 'benign',
    want,
    ms: 10,
    verdict: {
      outcome,
      reasons: outcome === 'allow' ? [] : [{ code, message: '', check: 'judge' }],
    },
  });

  it('counts catches and false positives, and keeps errors out of both', () => {
    expect(
      scoreJudge([
        row('catch', 'escalate'),
        row('catch', 'allow'),
        row('allow', 'escalate'),
        row('allow', 'allow'),
        row('catch', 'deny', 'CHECK_FAILED'),
        row('either', 'escalate'),
      ]),
    ).toMatchObject({
      cases: 6,
      errors: 1,
      attacks: 2,
      attacksCaught: 1,
      benign: 2,
      falsePositives: 1,
    });
  });
});
