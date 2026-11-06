import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MandateSchema, MandateStatus } from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import { mandateClaims } from './token.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const mandate = (status = MandateStatus.ACTIVE) =>
  create(MandateSchema, {
    id: 'm_1',
    agentId: 'ops-agent',
    task: 'Pay Arjun up to $100',
    tools: ['send_payout'],
    counterparties: ['arjun@mehta-dev.example'],
    maxPerCall: { value: '100.00', currency: 'USD' },
    maxTotal: { value: '200.00', currency: 'USD' },
    expiresAt: timestampFromMs(NOW + 4 * 3600_000),
    status,
  });

describe('mandateClaims', () => {
  it('states the scope exactly and ends when the mandate does', () => {
    expect(mandateClaims(mandate(), NOW)).toEqual({
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
      exp: NOW / 1000 + 4 * 3600,
    });
  });

  it('gives nothing for a revoked or expired mandate', () => {
    expect(mandateClaims(mandate(MandateStatus.REVOKED), NOW)).toBeUndefined();
    expect(mandateClaims(mandate(MandateStatus.EXPIRED), NOW)).toBeUndefined();
  });
});
