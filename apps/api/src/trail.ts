import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { CallSummary, LedgerEntry } from '@warden/contracts';
import { amountToken, emailToken, idToken } from '@warden/core';

// the paper trail behind a held payment: which reads of untrusted content carried its payee
// or amount, from what the gateway recorded (tool, item id, tokens). no content text is
// stored or shown, only that this item had this payee or amount in it.
export type Read = { tool: string; ref: string; at: string; payee: boolean; amount: boolean };
export type Trail = { reads: Read[]; paidBy?: string };

type Data = {
  callReceived?: { intent?: { sessionId?: string; refs?: Record<string, string> } };
  untrustedContentObserved?: { sourceTool?: string; sourceRef?: string; tokens?: string[] };
};
const data = (e: LedgerEntry): Data => {
  try {
    return JSON.parse(e.dataJson) as Data;
  } catch {
    return {};
  }
};

export const intentOf = (entries: LedgerEntry[]) =>
  entries.map((e) => data(e).callReceived?.intent).find(Boolean);

export function trail(call: CallSummary, entries: LedgerEntry[], session: LedgerEntry[]): Trail {
  const to = call.counterparty;
  const payee = to ? (to.includes('@') ? emailToken(to) : idToken(to)) : undefined;
  const [whole, frac] = call.amount?.value.split('.') ?? [];
  const amount = whole ? amountToken(whole, frac) : undefined;
  const reads: Read[] = [];
  for (const e of session) {
    const o = data(e).untrustedContentObserved;
    if (!o) continue;
    const r = {
      tool: o.sourceTool ?? '',
      ref: o.sourceRef ?? '',
      at: e.occurredAt ? timestampDate(e.occurredAt).toISOString() : '',
      payee: payee !== undefined && (o.tokens ?? []).includes(payee),
      amount: amount !== undefined && (o.tokens ?? []).includes(amount),
    };
    if (r.payee || r.amount) reads.push(r);
  }
  const paidBy = intentOf(entries)?.refs?.paid_by;
  return { reads, ...(paidBy ? { paidBy } : {}) };
}
