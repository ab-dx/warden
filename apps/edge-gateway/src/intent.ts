import { createHash, randomUUID } from 'node:crypto';
import { create, toJson } from '@bufbuild/protobuf';
import { type Json, PaymentIntentSchema, Tier as ProtoTier } from '@warden/contracts';
import type { Normalised, Tier } from './registry.js';

const PROTO_TIER: Record<Tier, ProtoTier> = {
  T0: ProtoTier.READ,
  T1: ProtoTier.WRITE,
  T2: ProtoTier.COMMIT,
  T3: ProtoTier.MONEY_OUT,
};

export const newCallId = () => `c_${randomUUID()}`;

// same agent, tool, payee, amount and references => same fingerprint, whatever the call id.
// this is what the duplicate rule compares.
export function fingerprint(agentId: string, tool: string, n: Normalised): string {
  const refs = Object.entries(n.refs).sort(([a], [b]) => a.localeCompare(b));
  const key = JSON.stringify([
    agentId,
    tool,
    n.counterparty ?? '',
    n.amount?.value ?? '',
    n.amount?.currency ?? '',
    refs,
  ]);
  return `fp_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

export function buildIntent(
  callId: string,
  agentId: string,
  sessionId: string,
  tool: string,
  tier: Tier,
  n: Normalised,
) {
  return create(PaymentIntentSchema, {
    callId,
    agentId,
    sessionId,
    tool,
    tier: PROTO_TIER[tier],
    refs: n.refs,
    fingerprint: fingerprint(agentId, tool, n),
    ...(n.amount ? { amount: n.amount } : {}),
    ...(n.counterparty ? { counterparty: n.counterparty } : {}),
  });
}

export const intentJson = (intent: ReturnType<typeof buildIntent>) =>
  toJson(PaymentIntentSchema, intent) as { [k: string]: Json };

// keeps the shape of the arguments for the audit trail, drops every value.
// the normalised intent carries the fields a reviewer needs.
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return v === null ? null : `<${typeof v}>`;
}
