import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalReceipt,
  type MandateClaims,
  signingKey,
  signMandate,
  signReceipt,
  verifyMandate,
  verifyReceipt,
} from './mandate-token.js';

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
  intent_mandate: {
    natural_language_description: 'Pay Arjun up to $100',
    merchants: ['arjun@mehta-dev.example'],
    skus: null,
    user_cart_confirmation_required: false,
    intent_expiry: new Date(NOW + 3600_000).toISOString(),
  },
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

describe('approval receipts', () => {
  const receipt: ApprovalReceipt = {
    iss: 'warden',
    kind: 'approval',
    jti: 'c_1',
    sub: 'ops-agent',
    approved: true,
    by: 'telegram:42',
    payment_mandate_contents: {
      payment_mandate_id: 'c_1',
      payment_details_id: 'c_1',
      payment_details_total: { label: 'send_payout', amount: { currency: 'USD', value: '120.00' } },
      merchant_agent: 'lena@ortiz.example',
      timestamp: new Date(NOW).toISOString(),
    },
    iat: NOW / 1000,
  };

  it('verifies a genuine receipt, years later, and nothing that was changed', () => {
    const token = signReceipt(receipt, key);
    expect(verifyReceipt(token, key.publicKey)).toEqual(receipt);
    const [h, , sig] = token.split('.');
    expect(() =>
      verifyReceipt(`${h}.${b64({ ...receipt, approved: false })}.${sig}`, key.publicKey),
    ).toThrow(/bad signature/);
  });

  it('will not take a mandate for a receipt', () => {
    expect(() => verifyReceipt(signMandate(claims, key), key.publicKey)).toThrow(/not an approval/);
  });
});
