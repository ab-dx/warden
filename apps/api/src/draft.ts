import { amountToken, contentTokens } from '@warden/core';
import { z } from 'zod';
import type { Complete } from './brief.js';

// turns the owner's plain words into a proposed mandate for the form. nothing is created
// here: the owner sees every field and presses grant themselves. and the model can only
// narrow what was written, never add to it: a payee or amount it proposes is kept only if
// it appears in the owner's own text, and the task stays the owner's words verbatim.

export const MANDATE_TOOLS = [
  'send_payout',
  'create_refund',
  'accept_dispute_claim',
  'pay_order',
  'create_order',
  'send_invoice',
  'create_subscription',
] as const;

const WEEK = 7 * 24 * 60;

const proposal = z.object({
  tools: z.array(z.string()).default([]),
  counterparties: z.array(z.string()).default([]),
  maxPerCall: z.string().nullable().default(null),
  maxTotal: z.string().nullable().default(null),
  expiresInMinutes: z.number().int().positive().nullable().default(null),
});

export type Draft = {
  task: string;
  tools: string[];
  counterparties: string[];
  maxPerCall: string | null;
  maxTotal: string | null;
  expiresInMinutes: number | null;
  // what the model proposed that wasn't in the owner's words, so it was left out
  dropped: string[];
  // the owner named payees. if none survived, an empty list would mean anyone, which is
  // wider than what they asked for, so the form must not grant it as is
  namedPayees: boolean;
};

const money = (v: string | null) => {
  const m = v ? /^(\d+)(?:\.(\d{1,2}))?$/.exec(v.replace(/[$,\s]/g, '')) : null;
  return m?.[1] ? `${m[1].replace(/^0+(?=\d)/, '')}.${(m[2] ?? '').padEnd(2, '0')}` : null;
};

export function vet(text: string, raw: unknown): Draft {
  const p = proposal.parse(raw);
  const said = new Set(contentTokens(text));
  const dropped: string[] = [];

  const keepMoney = (label: string, v: string | null) => {
    const m = money(v);
    if (!m) return null;
    const [whole = '', frac = ''] = m.split('.');
    if (said.has(amountToken(whole, frac))) return m;
    dropped.push(`${label} ${m} isn't in what you wrote`);
    return null;
  };

  // the model may write "Arjun (arjun@x.example)"; what counts is the address or id in it,
  // and only if the owner wrote that address or id themselves
  const counterparties = [
    ...new Set(
      p.counterparties.flatMap((c) => {
        const found = contentTokens(c).filter((t) => t.startsWith('email:') || t.startsWith('id:'));
        // a name like "lena" can't be paid or checked; only an address or an id can
        if (found.length === 0)
          dropped.push(
            `${c.trim()} has no email or PayPal id in what you wrote, so add it yourself to cover them`,
          );
        return found.flatMap((t) => {
          if (said.has(t)) return [t.slice(t.indexOf(':') + 1)];
          dropped.push(`payee ${t.slice(t.indexOf(':') + 1)} isn't in what you wrote`);
          return [];
        });
      }),
    ),
  ];
  const tools = p.tools.filter((t): t is (typeof MANDATE_TOOLS)[number] =>
    (MANDATE_TOOLS as readonly string[]).includes(t),
  );
  const maxPerCall = keepMoney('the per-payment limit', p.maxPerCall);
  let maxTotal = keepMoney('the total', p.maxTotal);
  // both are normalised to two decimals, so dropping the point gives exact cents
  const cents = (m: string) => BigInt(m.replace('.', ''));
  if (maxPerCall && maxTotal && cents(maxTotal) < cents(maxPerCall)) {
    dropped.push('the total was below the per-payment limit');
    maxTotal = null;
  }
  return {
    task: text.trim(),
    tools,
    counterparties,
    maxPerCall,
    maxTotal,
    expiresInMinutes: p.expiresInMinutes ? Math.min(p.expiresInMinutes, WEEK) : null,
    dropped,
    namedPayees: p.counterparties.length > 0,
  };
}

const SYSTEM = `You turn a small business owner's instruction to their AI payments assistant into a structured permission.
Only use payees, ids and amounts the owner actually wrote. If they didn't state something, use null or an empty list. Never invent a payee or a limit.
Tools you may choose from: ${MANDATE_TOOLS.join(', ')}. send_payout pays someone; create_refund refunds a customer; accept_dispute_claim concedes a dispute.
Reply with one JSON object and nothing else:
{"tools": [...], "counterparties": [...], "maxPerCall": "100.00" or null, "maxTotal": "200.00" or null, "expiresInMinutes": number or null}`;

export async function draftMandate(text: string, complete: Complete): Promise<Draft> {
  const reply = await complete(SYSTEM, text);
  // some models wrap json in prose or a code fence; take the object itself
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  return vet(text, JSON.parse(json));
}
