import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { CallSummary } from '@warden/contracts';
import { fromMinor, toMinor } from '@warden/core';

// the last 24 hours of payments, as counts the owner can read at a glance. money moved is
// summed in minor units per currency, never as floats
export function today(calls: CallSummary[], now: number) {
  const recent = calls.filter(
    (c) => c.receivedAt && now - timestampMs(c.receivedAt) < 24 * 3600_000,
  );
  const count = (status: string) => recent.filter((c) => c.status === status).length;
  const moved = new Map<string, bigint>();
  for (const c of recent) {
    if (c.status !== 'executed' || !c.amount) continue;
    moved.set(c.amount.currency, (moved.get(c.amount.currency) ?? 0n) + toMinor(c.amount));
  }
  return {
    completed: count('executed'),
    blocked: count('denied'),
    waiting: count('pending_approval'),
    paypalRefused: count('failed'),
    moved: [...moved].map(([currency, minor]) => fromMinor(minor, currency)),
  };
}
