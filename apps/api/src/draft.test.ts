import { describe, expect, it } from 'vitest';
import { draftMandate, vet } from './draft.js';

const TEXT =
  'Pay Arjun (arjun@mehta-dev.example) and Lena for this week, up to $100 each and $200 in total, until tomorrow.';

describe('vet', () => {
  it("keeps what the owner wrote and the owner's own words as the task", () => {
    const d = vet(TEXT, {
      tools: ['send_payout'],
      counterparties: ['Arjun@Mehta-Dev.example'],
      maxPerCall: '100',
      maxTotal: '$200.00',
      expiresInMinutes: 1440,
    });
    expect(d).toEqual({
      task: TEXT,
      tools: ['send_payout'],
      counterparties: ['arjun@mehta-dev.example'],
      maxPerCall: '100.00',
      maxTotal: '200.00',
      expiresInMinutes: 1440,
      dropped: [],
      namedPayees: true,
    });
  });

  it('takes the address out of a payee written as a name with an address', () => {
    const d = vet(TEXT, { counterparties: ['Arjun (arjun@mehta-dev.example)', 'Lena'] });
    expect(d.counterparties).toEqual(['arjun@mehta-dev.example']);
    expect(d.namedPayees).toBe(true);
  });

  it('flags a draft whose named payees all fell out, so it cannot widen to anyone', () => {
    const d = vet('Pay Lena up to $50', { counterparties: ['Lena'], maxPerCall: '50.00' });
    expect(d.counterparties).toEqual([]);
    expect(d.namedPayees).toBe(true);
    expect(vet('Pay anyone up to $50', { counterparties: [] }).namedPayees).toBe(false);
  });

  it('drops a payee or a limit the model made up', () => {
    const d = vet(TEXT, {
      tools: ['send_payout'],
      // lena's address was never written, so the model can't supply one
      counterparties: ['arjun@mehta-dev.example', 'lena@ortiz-illustration.example'],
      maxPerCall: '150.00',
      maxTotal: '200.00',
    });
    expect(d.counterparties).toEqual(['arjun@mehta-dev.example']);
    expect(d.maxPerCall).toBeNull();
    expect(d.dropped).toEqual([
      "payee lena@ortiz-illustration.example isn't in what you wrote",
      "the per-payment limit 150.00 isn't in what you wrote",
    ]);
  });

  it('drops unknown tools, a total below the cap, and caps the duration at a week', () => {
    const d = vet('refund up to $50 each, $20 in total', {
      tools: ['create_refund', 'transfer_everything'],
      maxPerCall: '50.00',
      maxTotal: '20.00',
      expiresInMinutes: 999_999,
    });
    expect(d.tools).toEqual(['create_refund']);
    expect(d.maxTotal).toBeNull();
    expect(d.dropped).toContain('the total was below the per-payment limit');
    expect(d.expiresInMinutes).toBe(10080);
  });

  it('says a bare name needs an address, not that it was never written', () => {
    const d = vet(TEXT, { tools: ['send_payout'], counterparties: ['Lena'] });
    expect(d.dropped).toEqual([
      'Lena has no email or PayPal id in what you wrote, so add it yourself to cover them',
    ]);
  });

  it('keeps a payment id the owner named', () => {
    const d = vet('Refund Maya, payment 3KD58209XH4419204, up to $50', {
      tools: ['create_refund'],
      counterparties: ['3KD58209XH4419204', '7TR10456BC2293811'],
      maxPerCall: '50.00',
    });
    expect(d.counterparties).toEqual(['3KD58209XH4419204']);
  });
});

describe('draftMandate', () => {
  it('reads the json even when the model wraps it in prose', async () => {
    const d = await draftMandate(
      TEXT,
      async () => 'Sure!\n```json\n{"tools":["send_payout"],"maxPerCall":"100.00"}\n```',
    );
    expect(d.maxPerCall).toBe('100.00');
    expect(d.counterparties).toEqual([]);
  });

  it('fails loudly on a reply with no json, for the endpoint to report', async () => {
    await expect(draftMandate(TEXT, async () => 'I cannot help with that.')).rejects.toThrow();
  });
});
