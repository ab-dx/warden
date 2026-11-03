import { describe, expect, it } from 'vitest';
import { duration, forUser, left, money } from './format.js';

describe('money', () => {
  it('groups digits without touching the decimals', () => {
    expect(money({ value: '1234567.05', currency: 'USD' })).toBe('$1,234,567.05');
    expect(money({ value: '0.10', currency: 'USD' })).toBe('$0.10');
    expect(money({ value: '1500', currency: 'JPY' })).toBe('1,500 JPY');
    expect(money(undefined)).toBe('Amount unknown');
  });
});

describe('forUser', () => {
  it('keeps the first sentence only', () => {
    expect(
      forUser('Payment to a@b.co is not covered by your mandate. Ask the user to approve.'),
    ).toBe('Payment to a@b.co is not covered by your mandate.');
    expect(forUser('120.00 USD is above the limit of 100.00 USD.')).toBe(
      '120.00 USD is above the limit of 100.00 USD.',
    );
  });
});

describe('duration', () => {
  it('reads like a person would say it', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(duration('2026-01-01T11:59:00Z', now)).toBe('12 hours');
    expect(duration('2026-01-01T00:45:00Z', now)).toBe('45 minutes');
    expect(duration('2026-01-08T00:00:00Z', now)).toBe('7 days');
  });
});

describe('left', () => {
  it('counts down in minutes and seconds and stops at zero', () => {
    expect(left('2026-01-01T00:02:05Z', Date.parse('2026-01-01T00:00:00Z'))).toBe('2:05');
    expect(left('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:01:00Z'))).toBe('0:00');
  });
});
