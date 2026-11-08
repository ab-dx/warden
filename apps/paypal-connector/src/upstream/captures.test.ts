import { describe, expect, it } from 'vitest';
import { TokenProvider } from '../token.js';
import { getCapture } from './captures.js';

const tokens = new TokenProvider(async () => ({ token: 't', expiresIn: 3600 }));
const respond = (status: number, body: unknown) => {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, urls };
};

describe('getCapture', () => {
  it('returns the capture amount', async () => {
    const f = respond(200, {
      id: '41F911146U935850G',
      status: 'COMPLETED',
      amount: { value: '40.00', currency_code: 'USD' },
    });
    const r = await getCapture('https://x', tokens, { capture_id: '41F911146U935850G' }, f.impl);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content[0]?.text ?? '{}').amount).toEqual({
      value: '40.00',
      currency_code: 'USD',
    });
  });

  it("names who paid, from the capture's order", async () => {
    const bodies: Record<string, unknown> = {
      '/v2/payments/captures/41F911146U935850G': {
        id: '41F911146U935850G',
        status: 'COMPLETED',
        amount: { value: '48.00', currency_code: 'USD' },
        supplementary_data: { related_ids: { order_id: '6B037444UM841841X' } },
      },
      '/v2/checkout/orders/6B037444UM841841X': {
        payer: { name: { given_name: 'Kim', surname: 'Lowe' }, email_address: 'k@x.example' },
      },
    };
    const impl = (async (url: string) =>
      new Response(JSON.stringify(bodies[new URL(url).pathname] ?? {}), {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await getCapture('https://x', tokens, { capture_id: '41F911146U935850G' }, impl);
    expect(JSON.parse(r.content[0]?.text ?? '{}').paid_by).toBe('Kim Lowe <k@x.example>');

    bodies['/v2/checkout/orders/6B037444UM841841X'] = {
      payment_source: { card: { name: 'Maya Chen' } },
    };
    const card = await getCapture('https://x', tokens, { capture_id: '41F911146U935850G' }, impl);
    expect(JSON.parse(card.content[0]?.text ?? '{}').paid_by).toBe('Maya Chen');
  });

  it("still returns the capture when its order can't be read", async () => {
    const impl = (async (url: string) =>
      url.includes('/orders/')
        ? new Response('{}', { status: 500 })
        : new Response(
            JSON.stringify({
              id: '41F911146U935850G',
              amount: { value: '48.00', currency_code: 'USD' },
              supplementary_data: { related_ids: { order_id: '6B037444UM841841X' } },
            }),
            { status: 200 },
          )) as unknown as typeof fetch;
    const r = await getCapture('https://x', tokens, { capture_id: '41F911146U935850G' }, impl);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content[0]?.text ?? '{}').paid_by).toBeUndefined();
  });

  it('refuses ids that could change the request path', async () => {
    const f = respond(200, {});
    for (const id of ['../../v1/payments/payouts', 'abc', 41]) {
      expect(await getCapture('https://x', tokens, { capture_id: id }, f.impl)).toMatchObject({
        ok: false,
      });
    }
    expect(f.urls).toHaveLength(0);
  });

  it('reports a missing capture as a failure', async () => {
    const f = respond(404, { name: 'RESOURCE_NOT_FOUND' });
    expect(
      await getCapture('https://x', tokens, { capture_id: '41F911146U935850G' }, f.impl),
    ).toMatchObject({ ok: false, errorCode: 'RESOURCE_NOT_FOUND' });
  });
});
