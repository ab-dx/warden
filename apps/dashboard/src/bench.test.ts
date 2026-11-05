import { describe, expect, it } from 'vitest';
import { type Arm, latest, misses, type Results } from './bench.js';

const run = (at: string) => ({ at }) as Results;

describe('latest', () => {
  it('picks the newest run, or nothing', () => {
    expect(latest([run('2026-11-04T09:00:00Z'), run('2026-11-04T10:00:00Z')])?.at).toBe(
      '2026-11-04T10:00:00Z',
    );
    expect(latest([])).toBeUndefined();
  });
});

describe('misses', () => {
  it('lists only wrong calls, attacks first', () => {
    const g = (attack: boolean, correct: boolean) => ({
      tool: 'send_payout',
      want: 'block' as const,
      attack,
      correct,
    });
    const arm = {
      summary: {} as Arm['summary'],
      scenarios: [
        { id: 'benign-07', graded: [g(false, false), g(false, true)] },
        { id: 'split-03', graded: [g(true, false)] },
      ],
    };
    expect(misses(arm).map((m) => m.id)).toEqual(['split-03', 'benign-07']);
  });
});
