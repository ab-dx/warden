import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { needsPasskey, passkeys } from './passkey.js';

const usd = (value: string) => ({ amount: { value, currency: 'USD' } as never });

describe('needsPasskey', () => {
  it('asks for one only to approve above the line, or when the amount is unknown', () => {
    expect(needsPasskey(usd('100.00'), true, 10000n)).toBe(false);
    expect(needsPasskey(usd('100.01'), true, 10000n)).toBe(true);
    expect(needsPasskey({ amount: undefined }, true, 10000n)).toBe(true);
  });

  it('never for saying no, and never when step-up is off', () => {
    expect(needsPasskey(usd('5000.00'), false, 10000n)).toBe(false);
    expect(needsPasskey(usd('5000.00'), true, undefined)).toBe(false);
  });
});

describe('passkeys', () => {
  const setup = (registered: boolean) => {
    const file = join(mkdtempSync(join(tmpdir(), 'pk-')), 'passkey.json');
    if (registered)
      writeFileSync(file, JSON.stringify({ id: 'cred1', publicKey: 'AA', counter: 0 }));
    return passkeys({ file, origin: 'http://localhost:7005', aboveMinor: 10000n });
  };

  it('fails closed without a challenge for that very call', async () => {
    const pk = setup(true);
    expect(await pk.check('c_1', { id: 'cred1' })).toBe(false);
    await pk.challengeFor('c_2');
    // a challenge issued for one payment can't approve another
    expect(await pk.check('c_1', { id: 'cred1' })).toBe(false);
    // and a garbage assertion for the right call is refused, once
    expect(await pk.check('c_2', { id: 'cred1' })).toBe(false);
  });

  it('keeps the first passkey: no second registration over it', async () => {
    const pk = setup(true);
    expect(pk.registered()).toBe(true);
    await expect(pk.registerOptions()).rejects.toThrow(/already registered/);
    const fresh = setup(false);
    expect((await fresh.registerOptions()).rp.id).toBe('localhost');
  });

  it('will not hand out a challenge before a passkey exists', async () => {
    await expect(setup(false).challengeFor('c_1')).rejects.toThrow(/register a passkey/);
  });
});
