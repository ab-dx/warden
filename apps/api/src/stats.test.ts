import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CallSummarySchema } from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import { today } from './stats.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const call = (status: string, value: string | null, hoursAgo: number) =>
  create(CallSummarySchema, {
    status,
    ...(value ? { amount: { value, currency: 'USD' } } : {}),
    receivedAt: timestampFromMs(NOW - hoursAgo * 3600_000),
  });

describe('today', () => {
  it('counts the last 24 hours by outcome and sums money moved exactly', () => {
    expect(
      today(
        [
          call('executed', '40.10', 1),
          call('executed', '0.20', 2),
          call('denied', '96.00', 3),
          call('pending_approval', '120.00', 0),
          call('failed', '5.00', 4),
          // yesterday doesn't count
          call('executed', '999.00', 25),
        ],
        NOW,
      ),
    ).toEqual({
      completed: 2,
      blocked: 1,
      waiting: 1,
      paypalRefused: 1,
      moved: [{ value: '40.30', currency: 'USD' }],
    });
  });

  it('says nothing moved on a quiet day', () => {
    expect(today([], NOW).moved).toEqual([]);
  });
});
