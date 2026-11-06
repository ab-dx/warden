import { timestampMs } from '@bufbuild/protobuf/wkt';
import { type CallSummary, type Mandate, MandateStatus } from '@warden/contracts';
import type { ApprovalReceipt, MandateClaims } from '@warden/core';

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
    intent_mandate: {
      natural_language_description: m.task,
      merchants: m.counterparties.length > 0 ? m.counterparties : null,
      skus: null,
      user_cart_confirmation_required: false,
      intent_expiry: new Date(timestampMs(m.expiresAt)).toISOString(),
    },
  };
}

// the owner's answer on one held call, as it stood when they gave it
export function receiptClaims(
  call: CallSummary,
  approved: boolean,
  by: string,
  now = Date.now(),
): ApprovalReceipt {
  return {
    iss: 'warden',
    kind: 'approval',
    jti: call.callId,
    sub: call.agentId,
    approved,
    by,
    payment_mandate_contents: {
      payment_mandate_id: call.callId,
      payment_details_id: call.callId,
      payment_details_total: {
        label: call.tool,
        amount: { currency: call.amount?.currency ?? '', value: call.amount?.value ?? '' },
      },
      merchant_agent: call.counterparty ?? '',
      timestamp: new Date(now).toISOString(),
    },
    iat: Math.floor(now / 1000),
  };
}
