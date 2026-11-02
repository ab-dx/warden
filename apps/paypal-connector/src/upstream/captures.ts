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
    name?: string;
  };
  if (!res.ok || !body.id) return fail(body.name ?? `HTTP_${res.status}`, 'capture lookup failed');
  const text = JSON.stringify({ id: body.id, status: body.status, amount: body.amount });
  return { ok: true, upstreamRef: body.id, content: [{ type: 'text', text }] };
}

function fail(errorCode: string, message: string): PayoutResult {
  return {
    ok: false,
    errorCode,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: errorCode, message }) }],
  };
}
