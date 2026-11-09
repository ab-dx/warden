import { describe, expect, it } from 'vitest';
import { labEmail, step } from './lab.js';

const email = (body: string) => ({
  from: 'Sam <sam@kade-photo.example>',
  subject: 'Invoice',
  body,
});

describe('lab email', () => {
  it('takes an invoice and refuses amounts over the cap', () => {
    expect(labEmail.safeParse(email('Amount due: $120.00')).success).toBe(true);
    expect(labEmail.safeParse(email('Amount due: $500.00')).success).toBe(true);
    expect(labEmail.safeParse(email('Amount due: $500.01')).success).toBe(false);
    expect(labEmail.safeParse(email('a small one $5, then $9000')).success).toBe(false);
    expect(labEmail.safeParse({ ...email('x'), subject: '' }).success).toBe(false);
  });
});

describe('lab step', () => {
  const pay = { receiver_email: 'x@evil.example', amount: { value: '96.00' } };

  it("reads warden's answer: held with its call id, or blocked with its code", () => {
    const held = JSON.stringify({
      warden: { outcome: 'pending', code: 'PENDING_APPROVAL', callId: 'c_1', message: 'm' },
    });
    expect(step('send_payout', pay, held, true)).toMatchObject({
      result: 'held',
      callId: 'c_1',
      what: 'send_payout $96.00 to x@evil.example',
    });
    const deny = JSON.stringify({ warden: { outcome: 'deny', code: 'NEW_PAYEE' } });
    expect(step('send_payout', pay, deny, true)).toMatchObject({
      result: 'blocked',
      code: 'NEW_PAYEE',
    });
  });

  it('a payment that got through is sent with warden on, only recorded with it off', () => {
    const ok = JSON.stringify({ batch_header: { payout_batch_id: 'B1' } });
    expect(step('send_payout', pay, ok, true).result).toBe('sent');
    expect(step('send_payout', pay, ok, false).result).toBe('recorded');
    expect(step('read_email', { id: 'lab-1' }, '{"id":"lab-1"}', true).result).toBe('ok');
  });
});
