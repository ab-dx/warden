import type { GuardReason, GuardResult } from '@warden/contracts';

export type ToolResult = {
  content: { type: 'text'; text: string }[] | unknown[];
  isError?: boolean;
};

const body = (warden: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ warden }) }],
});

// a denied call tells the agent why in a form it can act on, instead of an opaque error
export function denied(callId: string, reasons: GuardReason[], outcome = 'deny'): ToolResult {
  const first = reasons[0] ?? { code: 'DENIED', message: 'This call was not allowed.' };
  return {
    ...body({
      outcome,
      code: first.code,
      message: first.message,
      reasons,
      callId,
      approvalUrl: null,
    }),
    isError: true,
  };
}

export function pending(callId: string, approvalUrl: string): ToolResult {
  return body({
    outcome: 'pending',
    code: 'PENDING_APPROVAL',
    message:
      'This payment needs the user to approve it. Tell the user, then call warden_check_approval with this callId to get the result. Do not retry the payment.',
    callId,
    approvalUrl,
  });
}

export function finished(callId: string, r: GuardResult): ToolResult {
  if (r.outcome === 'deny') return denied(callId, r.reasons);
  const res = r.result;
  if (!res)
    return denied(callId, [
      { code: 'NO_RESULT', message: 'The call finished without a result.', check: 'gateway' },
    ]);
  if (res.errorCode === 'OUTCOME_UNKNOWN') {
    return denied(
      callId,
      [
        {
          code: 'OUTCOME_UNKNOWN',
          message:
            'PayPal may or may not have processed this payment. Do not retry it. Check list_transactions or ask the user.',
          check: 'gateway',
        },
      ],
      'unknown',
    );
  }
  return { content: res.content, ...(res.ok ? {} : { isError: true }) };
}
