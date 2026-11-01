import { describe, expect, it } from 'vitest';
import { TokenProvider } from './token.js';

describe('TokenProvider', () => {
  it('reuses a token until shortly before expiry, then refreshes', async () => {
    let now = 0;
    let n = 0;
    const tokens = new TokenProvider(
      async () => ({ token: `t${++n}`, expiresIn: 3600 }),
      () => now,
      0,
    );
    expect(await tokens.get()).toBe('t1');
    now = 50 * 60_000;
    expect(await tokens.get()).toBe('t1');
    now = 56 * 60_000;
    expect(await tokens.get()).toBe('t2');
  });

  it('mints once for concurrent callers', async () => {
    let n = 0;
    const tokens = new TokenProvider(async () => ({ token: `t${++n}`, expiresIn: 3600 }));
    const got = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(got).toEqual(['t1', 't1', 't1']);
    expect(n).toBe(1);
  });

  it('retries a flaky token endpoint and gives up after three tries', async () => {
    let n = 0;
    const flaky = new TokenProvider(
      async () => {
        if (++n < 3) throw new Error('503');
        return { token: 'ok', expiresIn: 3600 };
      },
      Date.now,
      0,
    );
    expect(await flaky.get()).toBe('ok');

    const dead = new TokenProvider(
      async () => {
        throw new Error('503');
      },
      Date.now,
      0,
    );
    await expect(dead.get()).rejects.toThrow('could not mint a paypal token');
  });
});
