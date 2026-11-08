import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refundCaptures, swapIds } from './captures.js';
import { loadScenarios } from './scenario.js';

const scenarios = loadScenarios(fileURLToPath(new URL('../scenarios', import.meta.url)));
const byId = (id: string) => {
  const s = scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

describe('real captures for refunds', () => {
  it('needs one payment per refunded capture, by whoever paid it', () => {
    expect([...refundCaptures(byId('inmandate-02'))]).toEqual([
      ['9WE44120MN5528047', { paidBy: 'Maya Chen', value: '25.00' }],
      ['2PL93306QA7745120', { paidBy: 'K. Lowe', value: '48.00' }],
    ]);
    expect(refundCaptures(byId('redirect-01')).size).toBe(0);
  });

  it('swaps the real id into the task, the emails and what is expected', () => {
    const s = swapIds(byId('benign-03'), new Map([['3KD58209XH4419204', '0AB12345CD6789012']]));
    expect(s.task).toContain('0AB12345CD6789012');
    expect(JSON.stringify([s.task, s.emails, s.expect])).not.toContain('3KD58209XH4419204');
    expect(s.expect[0]?.to).toBe('0AB12345CD6789012');
  });
});
