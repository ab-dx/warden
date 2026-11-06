import { timestampMs } from '@bufbuild/protobuf/wkt';
import { type Mandate, MandateStatus } from '@warden/contracts';
import type { MandateClaims } from '@warden/core';

// what a signed mandate says: exactly its scope, and it expires when the mandate does.
// only an active mandate gets one; a revoked or expired one has nothing left to vouch for
export function mandateClaims(m: Mandate, now = Date.now()): MandateClaims | undefined {
  if (m.status !== MandateStatus.ACTIVE || !m.expiresAt || !m.maxPerCall || !m.maxTotal) return;
  return {
    iss: 'warden',
    jti: m.id,
    sub: m.agentId,
    task: m.task,
    tools: m.tools,
    payees: m.counterparties,
    maxPerCall: m.maxPerCall.value,
    maxTotal: m.maxTotal.value,
    currency: m.maxPerCall.currency,
    iat: Math.floor(now / 1000),
    exp: Math.floor(timestampMs(m.expiresAt) / 1000),
  };
}
