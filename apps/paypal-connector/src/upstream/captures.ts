import type { TokenProvider } from '../token.js';
import type { PayoutResult } from './payouts.js';

// paypal's mcp server can't read a capture, and warden needs its amount to check a
// refund that leaves the amount out (paypal then refunds everything)
export const getCaptureTool = {
  name: 'get_capture',
  description: 'Get a captured payment by id, including its amount and status.',
  inputSchema: {
    type: 'object',
    properties: { capture_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{15,32}$' } },
    required: ['capture_id'],
    additionalProperties: false,
  },
} as const;

export async function getCapture(
  base: string,
  tokens: TokenProvider,
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<PayoutResult> {
  const id = (raw as { capture_id?: unknown } | undefined)?.capture_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{15,32}$/.test(id)) {
    return fail('INVALID_ARGUMENTS', 'capture_id must be a paypal capture id');
  }
  const res = await fetchImpl(`${base}/v2/payments/captures/${id}`, {
    headers: { authorization: `Bearer ${await tokens.get()}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    amount?: { value: string; currency_code: string };
    supplementary_data?: { related_ids?: { order_id?: string } };
    name?: string;
  };
  if (!res.ok || !body.id) return fail(body.name ?? `HTTP_${res.status}`, 'capture lookup failed');
  const orderId = body.supplementary_data?.related_ids?.order_id;
  const paidBy = orderId ? await payer(base, tokens, orderId, fetchImpl) : undefined;
  const text = JSON.stringify({
    id: body.id,
    status: body.status,
    amount: body.amount,
    ...(paidBy ? { paid_by: paidBy } : {}),
  });
  return { ok: true, upstreamRef: body.id, content: [{ type: 'text', text }] };
}

type Name = { given_name?: string; surname?: string };
type Order = {
  payer?: { name?: Name; email_address?: string };
  payment_source?: {
    card?: { name?: string };
    paypal?: { name?: Name; email_address?: string };
  };
};

const fullName = (n?: Name) => [n?.given_name, n?.surname].filter(Boolean).join(' ');

// the capture doesn't say who paid, its order does: the paypal account or the cardholder.
// best effort, a refund can still be checked on its amount without it
async function payer(
  base: string,
  tokens: TokenProvider,
  orderId: string,
  fetchImpl: typeof fetch,
) {
  if (!/^[A-Za-z0-9_-]{10,32}$/.test(orderId)) return undefined;
  try {
    const res = await fetchImpl(`${base}/v2/checkout/orders/${orderId}`, {
      headers: { authorization: `Bearer ${await tokens.get()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const o = (await res.json()) as Order;
    const who = o.payer ?? o.payment_source?.paypal;
    const name = fullName(who?.name) || o.payment_source?.card?.name || '';
    const email = who?.email_address;
    const out = email ? `${name} <${email}>`.trim() : name;
    return out ? out.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

function fail(errorCode: string, message: string): PayoutResult {
  return {
    ok: false,
    errorCode,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: errorCode, message }) }],
  };
}
