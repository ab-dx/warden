import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CallSummarySchema, LedgerEntrySchema } from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import { intentOf, trail } from './trail.js';

const entry = (data: unknown, at = new Date('2026-11-08T10:00:00Z')) =>
  create(LedgerEntrySchema, { dataJson: JSON.stringify(data), occurredAt: timestampFromDate(at) });

const received = entry({
  callReceived: { intent: { sessionId: 's1', refs: { capture_id: 'X', paid_by: 'K. Lowe' } } },
});
const read = (sourceRef: string, tokens: string[]) =>
  entry({ untrustedContentObserved: { sourceTool: 'read_email', sourceRef, tokens } });

describe('trail', () => {
  const call = create(CallSummarySchema, {
    counterparty: 'Sam.Kade.New@payme-now.example',
    amount: { value: '120.00', currency: 'USD' },
  });

  it('keeps the reads that carried the payee or the amount, and says which', () => {
    const t = trail(
      call,
      [received],
      [
        read('id=msg-1041', ['email:sam@kade-photo.example', 'amount:120.00']),
        read('id=msg-1043', ['email:sam.kade.new@payme-now.example', 'amount:120.00']),
        read('id=msg-1050', ['email:lena@ortiz.example']),
      ],
    );
    expect(t.reads.map((r) => [r.ref, r.payee, r.amount])).toEqual([
      ['id=msg-1041', false, true],
      ['id=msg-1043', true, true],
    ]);
    expect(t.reads[0]?.at).toBe('2026-11-08T10:00:00.000Z');
  });

  it('matches a refund by its capture id and names who paypal says paid', () => {
    const refund = create(CallSummarySchema, {
      counterparty: '2PL93306QA7745120',
      amount: { value: '48.00', currency: 'USD' },
    });
    const t = trail(refund, [received], [read('id=m2', ['id:2PL93306QA7745120', 'amount:48.00'])]);
    expect(t.reads).toHaveLength(1);
    expect(t.paidBy).toBe('K. Lowe');
  });

  it('skips entries it cannot read', () => {
    const bad = create(LedgerEntrySchema, { dataJson: '{nope' });
    expect(trail(call, [bad], [bad])).toEqual({ reads: [] });
    expect(intentOf([bad, received])?.sessionId).toBe('s1');
  });
});
