import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fingerprint, redact } from './intent.js';
import { hasNormaliser, type Lookup, normalise, TIERS } from './registry.js';

const captured = (f: string) =>
  (
    JSON.parse(readFileSync(new URL(`../../../docs/${f}`, import.meta.url), 'utf8')) as {
      tools: { name: string }[];
    }
  ).tools.map((t) => t.name);

const noLookup: Lookup = async () => {
  throw new Error('should not look anything up');
};
const lookupFrom =
  (bodies: Record<string, Record<string, unknown> | undefined>): Lookup =>
  async (tool) =>
    bodies[tool];

describe('registry', () => {
  it('has a tier for every tool the local paypal server and the connector expose', () => {
    const missing = [...captured('paypal-tools.stdio.json'), 'send_payout', 'get_capture'].filter(
      (n) => !(n in TIERS),
    );
    expect(missing).toEqual([]);
  });

  it('can build an intent for every tool that commits or moves money', () => {
    const gated = Object.entries(TIERS).filter(([, t]) => t === 'T2' || t === 'T3');
    expect(gated.filter(([n]) => !hasNormaliser(n))).toEqual([]);
  });
});

describe('normalise', () => {
  it('reads a payout and lowercases the payee', async () => {
    const n = await normalise(
      'send_payout',
      { receiver_email: 'Dev@Studio.Example', amount: { value: '40.00', currency_code: 'USD' } },
      noLookup,
    );
    expect(n).toEqual({
      amount: { value: '40.00', currency: 'USD' },
      counterparty: 'dev@studio.example',
      refs: {},
    });
  });

  it('uses the refund amount the agent gave over the captured one', async () => {
    const n = await normalise(
      'create_refund',
      { capture_id: 'CAP123456789012345', amount: { value: '5.00', currency_code: 'USD' } },
      lookupFrom({ get_capture: { amount: { value: '89.00', currency_code: 'USD' } } }),
    );
    expect(n.amount).toEqual({ value: '5.00', currency: 'USD' });
  });

  it('names who paid the refunded capture, as paypal reports it', async () => {
    const n = await normalise(
      'create_refund',
      { capture_id: 'CAP123456789012345', amount: { value: '48.00', currency_code: 'USD' } },
      lookupFrom({ get_capture: { paid_by: 'Kim Lowe <k@x.example>' } }),
    );
    expect(n.refs).toEqual({ capture_id: 'CAP123456789012345', paid_by: 'Kim Lowe <k@x.example>' });
  });

  it('looks up the capture when a refund leaves the amount out', async () => {
    const n = await normalise(
      'create_refund',
      { capture_id: 'CAP123456789012345' },
      lookupFrom({ get_capture: { amount: { value: '89.00', currency_code: 'USD' } } }),
    );
    expect(n).toMatchObject({
      amount: { value: '89.00' },
      counterparty: 'CAP123456789012345',
      refs: { capture_id: 'CAP123456789012345' },
    });
  });

  it('leaves the amount unknown when the lookup fails, so policy denies', async () => {
    const n = await normalise(
      'create_refund',
      { capture_id: 'CAP123456789012345' },
      lookupFrom({}),
    );
    expect(n.amount).toBeUndefined();
  });

  it('takes a dispute amount from the dispute', async () => {
    const n = await normalise(
      'accept_dispute_claim',
      { dispute_id: 'PP-D-1', note: 'x' },
      lookupFrom({ get_dispute: { dispute_amount: { value: '25.00', currency_code: 'USD' } } }),
    );
    expect(n.amount).toEqual({ value: '25.00', currency: 'USD' });
  });

  it('only prices an order with a single purchase unit', async () => {
    const one = { purchase_units: [{ amount: { value: '10.00', currency_code: 'USD' } }] };
    const two = {
      purchase_units: [
        { amount: { value: '10.00', currency_code: 'USD' } },
        { amount: { value: '1.00', currency_code: 'EUR' } },
      ],
    };
    expect(
      (await normalise('pay_order', { id: 'ORDER12345678901234' }, lookupFrom({ get_order: one })))
        .amount,
    ).toBeDefined();
    expect(
      (await normalise('pay_order', { id: 'ORDER12345678901234' }, lookupFrom({ get_order: two })))
        .amount,
    ).toBeUndefined();
  });

  it('survives a lookup that throws', async () => {
    const boom: Lookup = async () => {
      throw new Error('connector down');
    };
    expect(await normalise('create_refund', { capture_id: 'CAP123456789012345' }, boom)).toEqual({
      refs: {},
    });
  });
});

describe('fingerprint and redact', () => {
  const n = {
    amount: { value: '20.00', currency: 'USD' },
    counterparty: 'a@b.co',
    refs: { x: '1' },
  };
  it('matches repeats and separates different payments', () => {
    expect(fingerprint('ops', 'send_payout', n)).toBe(fingerprint('ops', 'send_payout', { ...n }));
    expect(fingerprint('ops', 'send_payout', n)).not.toBe(
      fingerprint('ops', 'send_payout', { ...n, amount: { value: '20.01', currency: 'USD' } }),
    );
    expect(fingerprint('ops', 'send_payout', n)).not.toBe(fingerprint('other', 'send_payout', n));
  });

  it('keeps argument shape but no values', () => {
    expect(
      redact({ receiver_email: 'a@b.co', amount: { value: '1.00' }, tags: ['x', 2], none: null }),
    ).toEqual({
      receiver_email: '<string>',
      amount: { value: '<string>' },
      tags: ['<string>', '<number>'],
      none: null,
    });
  });
});
