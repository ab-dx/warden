import { describe, expect, it } from 'vitest';
import { add, compare, fromMinor, toMinor } from './money.js';

const usd = (value: string) => ({ value, currency: 'USD' });

describe('money', () => {
  it('converts decimal strings to minor units and back', () => {
    expect(toMinor(usd('40.5'))).toBe(4050n);
    expect(toMinor(usd('120'))).toBe(12000n);
    expect(fromMinor(5n, 'USD')).toEqual(usd('0.05'));
    expect(toMinor({ value: '1500', currency: 'JPY' })).toBe(1500n);
  });

  it('rejects malformed amounts instead of guessing', () => {
    for (const v of ['-1.00', '1e3', '0.001', '1,000.00', ' 1.00', '', '.5']) {
      expect(() => toMinor(usd(v)), v).toThrow();
    }
    expect(() => toMinor({ value: '1.5', currency: 'JPY' })).toThrow();
    expect(() => toMinor({ value: '1.00', currency: 'usd' })).toThrow();
  });

  it('adds without float drift', () => {
    expect(add(usd('0.10'), usd('0.20'))).toEqual(usd('0.30'));
  });

  it('refuses to mix currencies', () => {
    expect(() => compare(usd('1.00'), { value: '1.00', currency: 'EUR' })).toThrow(/mismatch/);
    expect(compare(usd('19.99'), usd('20'))).toBe(-1);
  });
});
