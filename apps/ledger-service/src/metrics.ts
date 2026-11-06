import { timestampMs } from '@bufbuild/protobuf/wkt';
import { metrics } from '@opentelemetry/api';
import { DecidedBy, type Event, Outcome } from '@warden/contracts';

// the ledger sees every event, so it is the one place to count what warden decides.
// a no-op until the service starts the otel sdk

const name = (e: Record<number, string>, v: number, prefix: string) =>
  (e[v] ?? 'unknown').replace(prefix, '').toLowerCase();

// where an approval came from: dashboard, telegram, or nobody (timeout)
const via = (resolvedBy: string) => resolvedBy.split(':')[0] || 'unknown';

export type Sample =
  | { metric: 'decisions'; attrs: { outcome: string; decided_by: string } }
  | { metric: 'approvals'; attrs: { approved: string; via: string } }
  | { metric: 'payments'; attrs: { tool: string; ok: string; error: string } };

export function sample(event: Event): Sample | undefined {
  const p = event.payload;
  switch (p.case) {
    case 'decisionMade':
      return {
        metric: 'decisions',
        attrs: {
          outcome: name(Outcome, p.value.outcome, 'OUTCOME_'),
          decided_by: name(DecidedBy, p.value.decidedBy, 'DECIDED_BY_'),
        },
      };
    case 'approvalResolved':
      return {
        metric: 'approvals',
        attrs: { approved: String(p.value.approved), via: via(p.value.resolvedBy) },
      };
    case 'paymentExecuted':
      return {
        metric: 'payments',
        attrs: { tool: p.value.tool, ok: String(p.value.ok), error: p.value.errorCode ?? '' },
      };
    default:
      return undefined;
  }
}

const meter = metrics.getMeter('warden-ledger');
const counters = {
  decisions: meter.createCounter('warden_decisions', {
    description: 'payment decisions, by outcome and by which check decided',
  }),
  approvals: meter.createCounter('warden_approvals', {
    description: 'held payments the owner answered, or that timed out',
  }),
  payments: meter.createCounter('warden_payments', {
    description: 'calls forwarded to paypal, by result',
  }),
};
const decisionTime = meter.createHistogram('warden_decision_seconds', {
  description: 'time from the agent asking to warden deciding, owner included',
  unit: 's',
  advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300] },
});

// receivedAt: when the agent asked, for the decision time; only known for decisions
export function record(event: Event, receivedAt?: Date) {
  const s = sample(event);
  if (!s) return;
  counters[s.metric].add(1, s.attrs);
  if (s.metric === 'decisions' && receivedAt && event.occurredAt)
    decisionTime.record((timestampMs(event.occurredAt) - receivedAt.getTime()) / 1000, {
      outcome: s.attrs.outcome,
    });
}
