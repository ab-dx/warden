import type { Money } from '@warden/core';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3';

// filled in by hand from the captured tool list (docs/paypal-tools*.json). a tool
// missing here is hidden from agents and refused, never forwarded on a guess.
export const TIERS: Record<string, Tier> = {
  // read
  get_capture: 'T0',
  get_dispute: 'T0',
  get_invoice: 'T0',
  get_order: 'T0',
  get_refund: 'T0',
  get_shipment_tracking: 'T0',
  generate_invoice_qr_code: 'T0',
  list_disputes: 'T0',
  list_invoices: 'T0',
  list_products: 'T0',
  list_subscription_plans: 'T0',
  list_transactions: 'T0',
  show_product_details: 'T0',
  show_subscription_details: 'T0',
  show_subscription_plan_details: 'T0',
  // writes that move no money
  cancel_sent_invoice: 'T1',
  cancel_subscription: 'T1',
  create_invoice: 'T1',
  create_product: 'T1',
  create_shipment_tracking: 'T1',
  create_subscription_plan: 'T1',
  send_invoice_reminder: 'T1',
  update_product: 'T1',
  // commits a customer to a charge
  create_order: 'T2',
  create_subscription: 'T2',
  send_invoice: 'T2',
  // money moves
  accept_dispute_claim: 'T3',
  create_refund: 'T3',
  pay_order: 'T3',
  send_payout: 'T3',
};

export type Normalised = { amount?: Money; counterparty?: string; refs: Record<string, string> };

// reads a tool's json result through the connector; undefined when it can't
export type Lookup = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown> | undefined>;

type Normaliser = (args: Record<string, unknown>, lookup: Lookup) => Promise<Normalised>;

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

// paypal writes money as { value, currency_code }
export function paypalMoney(v: unknown): Money | undefined {
  const m = v as { value?: unknown; currency_code?: unknown } | undefined;
  if (typeof m?.value !== 'string' || typeof m.currency_code !== 'string') return undefined;
  return { value: m.value, currency: m.currency_code };
}

const ref = (key: string, value: string | undefined): Record<string, string> =>
  value ? { [key]: value } : {};

const NORMALISERS: Record<string, Normaliser> = {
  async send_payout(args) {
    const amount = paypalMoney(args.amount);
    const to = str(args.receiver_email)?.toLowerCase();
    return { ...(amount ? { amount } : {}), ...(to ? { counterparty: to } : {}), refs: {} };
  },

  async create_refund(args, lookup) {
    const id = str(args.capture_id);
    const capture = id ? await lookup('get_capture', { capture_id: id }) : undefined;
    // no amount means paypal refunds whatever is left on the capture, which is at most
    // the captured amount, so checking against that is safe
    const amount = paypalMoney(args.amount) ?? paypalMoney(capture?.amount);
    // who paypal says paid, so a refund to someone the owner didn't name can be caught
    const paidBy = str(capture?.paid_by);
    return {
      ...(amount ? { amount } : {}),
      ...(id ? { counterparty: id } : {}),
      refs: { ...ref('capture_id', id), ...ref('paid_by', paidBy?.slice(0, 120)) },
    };
  },

  async accept_dispute_claim(args, lookup) {
    const id = str(args.dispute_id);
    const amount = id
      ? paypalMoney((await lookup('get_dispute', { dispute_id: id }))?.dispute_amount)
      : undefined;
    return {
      ...(amount ? { amount } : {}),
      ...(id ? { counterparty: id } : {}),
      refs: ref('dispute_id', id),
    };
  },

  async pay_order(args, lookup) {
    const id = str(args.id);
    const order = id ? await lookup('get_order', { id }) : undefined;
    const units = (order?.purchase_units as { amount?: unknown }[] | undefined) ?? [];
    // several purchase units could mix currencies; only the simple case gets an amount
    const amount = units.length === 1 ? paypalMoney(units[0]?.amount) : undefined;
    return {
      ...(amount ? { amount } : {}),
      ...(id ? { counterparty: id } : {}),
      refs: ref('order_id', id),
    };
  },

  async send_invoice(args) {
    const id = str(args.invoice_id);
    return { ...(id ? { counterparty: id } : {}), refs: ref('invoice_id', id) };
  },

  async create_subscription(args) {
    const plan = str(args.plan_id);
    return { ...(plan ? { counterparty: plan } : {}), refs: ref('plan_id', plan) };
  },

  // item costs arrive as floats, so no amount is derived; policy still needs a mandate for it
  async create_order() {
    return { refs: {} };
  },
};

export async function normalise(
  tool: string,
  args: Record<string, unknown>,
  lookup: Lookup,
): Promise<Normalised> {
  const n = NORMALISERS[tool];
  if (!n) return { refs: {} };
  try {
    return await n(args, lookup);
  } catch {
    // an unreadable call gets no amount; policy denies money-out calls without one
    return { refs: {} };
  }
}

export const hasNormaliser = (tool: string) => tool in NORMALISERS;
