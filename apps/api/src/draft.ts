import { amountToken, contentTokens, emailToken, idToken } from '@warden/core';
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

  const counterparties = [
    ...new Set(
      p.counterparties.flatMap((c) => {
        const v = c.trim();
        const t = v.includes('@') ? emailToken(v) : idToken(v);
        if (said.has(t)) return [v.includes('@') ? v.toLowerCase() : v];
        dropped.push(`payee ${v} isn't in what you wrote`);
        return [];
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
