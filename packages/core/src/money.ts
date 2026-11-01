export type Money = { value: string; currency: string };

// paypal treats these as zero-decimal; everything else it supports uses two
const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD']);

const VALUE = /^(\d+)(?:\.(\d+))?$/;
const CURRENCY = /^[A-Z]{3}$/;

export function exponent(currency: string): number {
  if (!CURRENCY.test(currency)) throw new Error(`invalid currency: ${currency}`);
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

export function toMinor({ value, currency }: Money): bigint {
  const exp = exponent(currency);
  const m = VALUE.exec(value);
  if (!m) throw new Error(`invalid amount: ${value}`);
  const [, whole = '', frac = ''] = m;
  if (frac.length > exp) throw new Error(`too many decimals for ${currency}: ${value}`);
  return BigInt(whole + frac.padEnd(exp, '0'));
}

export function fromMinor(minor: bigint, currency: string): Money {
  if (minor < 0n) throw new Error('negative amount');
  const exp = exponent(currency);
  if (exp === 0) return { value: minor.toString(), currency };
  const s = minor.toString().padStart(exp + 1, '0');
  return { value: `${s.slice(0, -exp)}.${s.slice(-exp)}`, currency };
}

function sameCurrency(a: Money, b: Money) {
  if (a.currency !== b.currency)
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return fromMinor(toMinor(a) + toMinor(b), a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  const d = toMinor(a) - toMinor(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}
