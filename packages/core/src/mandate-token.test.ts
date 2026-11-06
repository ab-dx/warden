import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type MandateClaims, signingKey, signMandate, verifyMandate } from './mandate-token.js';

const key = signingKey(randomBytes(32).toString('base64url'));
const NOW = Date.parse('2026-11-06T12:00:00Z');
const claims: MandateClaims = {
  iss: 'warden',
  jti: 'm_1',
  sub: 'ops-agent',
  task: 'Pay Arjun up to $100',
  tools: ['send_payout'],
  payees: ['arjun@mehta-dev.example'],
  maxPerCall: '100.00',
  maxTotal: '200.00',
  currency: 'USD',
  iat: NOW / 1000,
  exp: NOW / 1000 + 3600,
};
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('mandate tokens', () => {
  it('round-trips a mandate signed with the key', () => {
    expect(verifyMandate(signMandate(claims, key), key.publicKey, NOW)).toEqual(claims);
  });

  it('rejects a widened scope, a stale token and another key', () => {
    const [h, , s] = signMandate(claims, key).split('.');
    expect(() =>
      verifyMandate(`${h}.${b64({ ...claims, maxPerCall: '1000.00' })}.${s}`, key.publicKey, NOW),
    ).toThrow(/bad signature/);
    expect(() => verifyMandate(signMandate(claims, key), key.publicKey, NOW + 3601_000)).toThrow(
      /expired/,
    );
    const other = signingKey(randomBytes(32).toString('base64url'));
    expect(() => verifyMandate(signMandate(claims, other), key.publicKey, NOW)).toThrow(
      /bad signature/,
    );
  });

  it('refuses alg none and malformed tokens', () => {
    expect(() =>
      verifyMandate(`${b64({ alg: 'none' })}.${b64(claims)}.`, key.publicKey, NOW),
    ).toThrow();
    expect(() => verifyMandate('a.b', key.publicKey, NOW)).toThrow(/compact jws/);
  });

  it('publishes a jwk any library can use, and rejects a bad seed', () => {
    expect(key.jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', kid: key.kid });
    expect(() => signingKey('short')).toThrow(/32-byte/);
  });
});
