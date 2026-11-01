import { toMinor } from '@warden/core';
import { z } from 'zod';
import type { TokenProvider } from '../token.js';
import type { Classified } from './result.js';

// paypal's mcp server has no payout tool, so warden exposes one over the rest api
export const sendPayoutTool = {
  name: 'send_payout',
  description:
    'Send money to a PayPal account by email. Use for paying contractors and suppliers. ' +
    'The payout is accepted immediately and settles asynchronously.',
  inputSchema: {
    type: 'object',
    properties: {
      receiver_email: {
        type: 'string',
        format: 'email',
        description: 'PayPal email of the payee.',
      },
      amount: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Decimal amount, e.g. "120.00".' },
          currency_code: { type: 'string', enum: ['USD'] },
        },
        required: ['value', 'currency_code'],
        additionalProperties: false,
      },
      note: { type: 'string', maxLength: 255, description: 'Shown to the payee.' },
    },
    required: ['receiver_email', 'amount'],
    additionalProperties: false,
  },
} as const;

const args = z
  .object({
    receiver_email: z.email(),
    amount: z
      .object({ value: z.string(), currency_code: z.literal('USD') })
      .strict()
      .refine((a) => {
        try {
          return toMinor({ value: a.value, currency: a.currency_code }) > 0n;
        } catch {
          return false;
        }
      }, 'amount must be a positive decimal string'),
    note: z.string().max(255).optional(),
  })
  .strict();

export type PayoutResult = Classified & { content: { type: 'text'; text: string }[] };

export async function sendPayout(
  base: string,
  tokens: TokenProvider,
  raw: unknown,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PayoutResult> {
  const parsed = args.safeParse(raw);
  if (!parsed.success) {
    return failure('INVALID_ARGUMENTS', parsed.error.issues.map((i) => i.message).join('; '));
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return failure('INVALID_IDEMPOTENCY_KEY', 'idempotency key must be 8-100 url-safe characters');
  }
  const { receiver_email, amount, note } = parsed.data;

  const res = await fetchImpl(`${base}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await tokens.get()}`,
      'content-type': 'application/json',
      'paypal-request-id': idempotencyKey,
    },
    body: JSON.stringify({
      // paypal rejects a reused sender_batch_id, a second guard against double payouts
      sender_batch_header: { sender_batch_id: idempotencyKey, email_subject: 'You have a payment' },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: receiver_email,
          amount: { value: amount.value, currency: amount.currency_code },
          ...(note ? { note } : {}),
          sender_item_id: idempotencyKey,
        },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    name?: string;
    message?: string;
    batch_header?: { payout_batch_id?: string; batch_status?: string };
  };
  if (!res.ok) return failure(body.name ?? `HTTP_${res.status}`, body.message ?? 'payout rejected');

  const batchId = body.batch_header?.payout_batch_id;
  if (!batchId) return failure('UNREADABLE_RESULT', 'payout accepted without a batch id');
  const text = JSON.stringify({
    payout_batch_id: batchId,
    batch_status: body.batch_header?.batch_status,
    amount: { value: amount.value, currency_code: amount.currency_code },
    receiver_email,
  });
  return { ok: true, upstreamRef: batchId, content: [{ type: 'text', text }] };
}

function failure(errorCode: string, message: string): PayoutResult {
  return {
    ok: false,
    errorCode,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: errorCode, message }) }],
  };
}
