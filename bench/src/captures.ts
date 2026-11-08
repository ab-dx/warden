import type { Scenario } from './scenario.js';

// scenarios name made-up capture ids. for a refund to be checked against who really paid,
// each id needs a real sandbox payment by that customer, so the bench makes one per id
// (card paid, the card in the customer's name) and swaps the real id in everywhere.

// capture id -> who paid it and the largest refund asked of it
export function refundCaptures(s: Scenario) {
  const out = new Map<string, { paidBy: string; value: string }>();
  for (const e of s.expect) {
    if (e.tool !== 'create_refund' || !e.paid_by) continue;
    const value = e.amount ?? '0.00';
    const had = out.get(e.to);
    if (!had || Number(value) > Number(had.value)) out.set(e.to, { paidBy: e.paid_by, value });
  }
  return out;
}

export function swapIds(s: Scenario, ids: Map<string, string>): Scenario {
  const swap = (t: string) => [...ids].reduce((acc, [from, to]) => acc.replaceAll(from, to), t);
  return {
    ...s,
    task: swap(s.task),
    emails: s.emails.map((e) => ({ ...e, subject: swap(e.subject), body: swap(e.body) })),
    expect: s.expect.map((e) => ({ ...e, to: swap(e.to) })),
  };
}

const base = () => {
  const b = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
  if (!b.includes('sandbox')) throw new Error(`refusing non-sandbox api base: ${b}`);
  return b;
};

async function token() {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set');
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`paypal token request failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

// one card-paid, captured order in the customer's name; returns the capture id
async function capture(auth: string, paidBy: string, value: string) {
  const res = await fetch(`${base()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${auth}`,
      'content-type': 'application/json',
      'paypal-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value }, description: 'bench order' }],
      // paypal's sandbox test visa; captures straight away, no buyer redirect
      payment_source: {
        card: { number: '4111111111111111', expiry: '2030-12', name: paidBy, security_code: '123' },
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    status?: string;
    debug_id?: string;
    purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[];
  };
  const c = body.purchase_units?.[0]?.payments?.captures?.[0];
  if (!res.ok || body.status !== 'COMPLETED' || c?.status !== 'COMPLETED')
    throw new Error(
      `seeding a capture for ${paidBy} failed: ${res.status} (debug_id ${body.debug_id})`,
    );
  return c.id;
}

export async function withRealCaptures(s: Scenario): Promise<Scenario> {
  const wanted = refundCaptures(s);
  if (!wanted.size) return s;
  const auth = await token();
  const ids = new Map<string, string>();
  for (const [fake, { paidBy, value }] of wanted) ids.set(fake, await capture(auth, paidBy, value));
  return swapIds(s, ids);
}
