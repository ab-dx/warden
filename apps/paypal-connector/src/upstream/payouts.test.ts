import { describe, expect, it } from 'vitest';
import { TokenProvider } from '../token.js';
import { sendPayout } from './payouts.js';

const tokens = new TokenProvider(async () => ({ token: 'tok', expiresIn: 3600 }));
const good = { receiver_email: 'c@example.com', amount: { value: '120.00', currency_code: 'USD' } };
const KEY = 'call_abc123';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('sendPayout', () => {
  it('sends the idempotency key as request id and batch id', async () => {
    const f = fakeFetch(201, { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } });
    const r = await sendPayout('https://api-m.sandbox.paypal.com', tokens, good, KEY, f.impl);
    expect(r).toMatchObject({ ok: true, upstreamRef: 'B1' });
    const init = f.calls[0]?.init ?? ({} as RequestInit);
    expect((init.headers as Record<string, string>)['paypal-request-id']).toBe(KEY);
    expect(JSON.parse(init.body as string).sender_batch_header.sender_batch_id).toBe(KEY);
  });

  it.each([
    [{ ...good, amount: { value: '-5.00', currency_code: 'USD' } }],
    [{ ...good, amount: { value: '0.00', currency_code: 'USD' } }],
    [{ ...good, amount: { value: 120, currency_code: 'USD' } }],
    [{ ...good, amount: { value: '1.001', currency_code: 'USD' } }],
    [{ ...good, amount: { value: '10.00', currency_code: 'EUR' } }],
    [{ ...good, receiver_email: 'not-an-email' }],
    [{ ...good, extra: 'field' }],
  ])('rejects bad arguments without calling paypal: %j', async (args) => {
    const f = fakeFetch(201, {});
    const r = await sendPayout('https://x', tokens, args, KEY, f.impl);
    expect(r).toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a missing or odd idempotency key', async () => {
    const f = fakeFetch(201, {});
    expect(await sendPayout('https://x', tokens, good, '', f.impl)).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
  });

  it('reports paypal rejections with their error name', async () => {
    const f = fakeFetch(403, { name: 'PAYOUT_NOT_AVAILABLE', message: 'country' });
    const r = await sendPayout('https://x', tokens, good, KEY, f.impl);
    expect(r).toMatchObject({ ok: false, errorCode: 'PAYOUT_NOT_AVAILABLE' });
  });
});
