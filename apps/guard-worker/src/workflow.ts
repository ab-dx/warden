import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  Decision,
  Evaluation,
  Forwarded,
  GuardDecidedBy,
  GuardInput,
  GuardResult,
} from '@warden/contracts';
import type { Activities } from './activities.js';

const policy = proxyActivities<Activities>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 3 },
});
// the judge may wait on a model; a retry only asks it again
const judge = proxyActivities<Activities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 2 },
});
// settle, release and emit are idempotent, so keep trying until they land
const durable = proxyActivities<Activities>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 50, maximumInterval: '30s' },
});
// never retried: paypal's mcp tools can't carry an idempotency key, so a retry could pay twice
const upstream = proxyActivities<Activities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 1 },
});

export const decideSignal = defineSignal<[Decision]>('decide');
export const statusQuery = defineQuery<string>('status');

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export async function paymentGuard(input: GuardInput): Promise<GuardResult> {
  const { callId } = input;
  let status = 'evaluating';
  let decision: Decision | undefined;
  setHandler(statusQuery, () => status);
  // first answer wins; a late second tap can't flip it
  setHandler(decideSignal, (d) => {
    decision ??= d;
  });

  let pre: Evaluation;
  try {
    pre = await judge.assess(input);
  } catch {
    pre = {
      outcome: 'deny',
      reasons: [{ code: 'CHECK_FAILED', message: 'judge service did not answer', check: 'judge' }],
    };
  }

  // a judge deny skips policy, so nothing is reserved; a judge hold goes to policy,
  // which can only make it stricter
  let ev: Evaluation = pre;
  if (pre.outcome !== 'deny') {
    try {
      ev = await policy.evaluate(input, pre.outcome === 'escalate' ? pre.reasons : []);
    } catch {
      ev = {
        outcome: 'deny',
        reasons: [
          { code: 'CHECK_FAILED', message: 'policy service did not answer', check: 'policy' },
        ],
      };
    }
  }

  let outcome: 'allow' | 'deny' = ev.outcome === 'allow' ? 'allow' : 'deny';
  let reasons = ev.reasons;
  let decidedBy: GuardDecidedBy = pre.outcome === 'deny' ? 'judge' : 'policy';

  if (ev.outcome === 'escalate') {
    const timeoutMs = input.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const expiresAt = new Date(workflowInfo().runStartTime.getTime() + timeoutMs).toISOString();
    await durable.emit({ kind: 'approvalRequested', callId, reasons, expiresAt });
    status = 'awaiting_approval';

    const answered = await condition(() => decision !== undefined, timeoutMs);
    const approved = answered && decision?.approved === true;
    decidedBy = answered ? 'human' : 'timeout';
    outcome = approved ? 'allow' : 'deny';
    if (!approved) {
      reasons = [
        ...reasons,
        answered
          ? {
              code: 'APPROVAL_REJECTED',
              message: 'the user rejected this payment',
              check: 'approval',
            }
          : {
              code: 'APPROVAL_TIMEOUT',
              message: 'nobody approved this payment in time',
              check: 'approval',
            },
      ];
    }
    await durable.emit({
      kind: 'approvalResolved',
      callId,
      approved,
      by: decision?.by ?? 'timeout',
      receipt: decision?.receipt,
    });
  }

  await durable.emit({
    kind: 'decisionMade',
    callId,
    outcome,
    reasons,
    decidedBy,
    mandateId: ev.mandateId,
    reservationId: ev.reservationId,
  });

  if (outcome === 'deny') {
    status = 'denied';
    if (ev.reservationId) await release(callId, ev.reservationId, 'denied');
    return { outcome, reasons, decidedBy };
  }

  status = 'forwarding';
  let result: Forwarded;
  try {
    result = await upstream.forward(input);
  } catch {
    // we can't tell whether paypal moved the money, so the hold stays on the budget
    status = 'unknown';
    result = { ok: false, content: [], errorCode: 'OUTCOME_UNKNOWN' };
    await durable.emit({
      kind: 'paymentExecuted',
      callId,
      tool: input.tool,
      ok: false,
      errorCode: result.errorCode,
    });
    return { outcome, reasons, decidedBy, result };
  }

  if (ev.reservationId) {
    if (result.ok) await durable.settle(ev.reservationId, input.intent, result.upstreamRef ?? '');
    else
      await release(callId, ev.reservationId, `upstream failed: ${result.errorCode ?? 'unknown'}`);
  }
  await durable.emit({
    kind: 'paymentExecuted',
    callId,
    tool: input.tool,
    ok: result.ok,
    upstreamRef: result.upstreamRef,
    errorCode: result.errorCode,
  });
  status = result.ok ? 'done' : 'failed';
  return { outcome, reasons, decidedBy, result };
}

async function release(callId: string, reservationId: string, reason: string) {
  await durable.release(reservationId, reason);
  await durable.emit({ kind: 'reservationReleased', callId, reservationId, reason });
}
