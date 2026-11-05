import { create } from '@bufbuild/protobuf';
import { CallSummarySchema } from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import type { Decided } from './approvals.js';
import { heldMessage, telegramApprovals } from './telegram.js';

const CALL = 'c_0b7e2c1a-5d3f-4e8a-9c21-7f6b5a4d3e2c';
const OWNER = 4242;

const held = (callId = CALL) => ({
  call: create(CallSummarySchema, {
    callId,
    tool: 'send_payout',
    amount: { value: '96.00', currency: 'USD' },
    counterparty: 'new-bank@attacker.example',
    reasons: [
      { code: 'COUNTERPARTY_NOT_IN_MANDATE', message: 'Not in your mandate.', check: 'policy' },
    ],
  }),
  expiresAt: '2026-11-05T09:30:00.000Z',
});

function setup(opts: { pending?: ReturnType<typeof held>[]; result?: Decided } = {}) {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const decided: [string, boolean, string][] = [];
  let updates: unknown[] = [];
  const t = telegramApprovals({
    chatId: OWNER,
    bot: async (method, body) => {
      sent.push({ method, body: body as Record<string, unknown> });
      if (method !== 'getUpdates') return true;
      const u = updates;
      updates = [];
      return u;
    },
    pending: async () => opts.pending ?? [held()],
    decide: async (callId, approved, by) => {
      decided.push([callId, approved, by]);
      return opts.result ?? 'sent';
    },
  });
  const tap = (data: string, chat = OWNER, id = 1) => {
    updates = [
      {
        update_id: id,
        callback_query: {
          id: `q${id}`,
          data,
          from: { id: 7, username: 'priya' },
          message: { message_id: 10, chat: { id: chat } },
        },
      },
    ];
  };
  return { t, sent, decided, tap };
}

describe('telegram approvals', () => {
  it('asks about each held payment once, with what and why', async () => {
    const { t, sent } = setup();
    await t.notify();
    await t.notify();
    const msgs = sent.filter((s) => s.method === 'sendMessage');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.body.chat_id).toBe(OWNER);
    expect(msgs[0]?.body.text).toContain('send_payout: 96.00 USD to new-bank@attacker.example');
    expect(msgs[0]?.body.text).toContain('- Not in your mandate.');
    expect(JSON.stringify(msgs[0]?.body.reply_markup)).toContain(`a:${CALL}`);
  });

  it("turns the owner's tap into the same decision the dashboard makes", async () => {
    const { t, sent, decided, tap } = setup();
    tap(`r:${CALL}`);
    await t.answer(0);
    expect(decided).toEqual([[CALL, false, 'telegram:priya']]);
    expect(sent.find((s) => s.method === 'answerCallbackQuery')?.body.text).toBe('Rejected.');
  });

  it('ignores taps from any other chat and data it did not send', async () => {
    const { t, decided, tap } = setup();
    tap(`a:${CALL}`, 999);
    await t.answer(0);
    tap('a:c_../../evil', OWNER, 2);
    await t.answer(0);
    tap(`x:${CALL}`, OWNER, 3);
    await t.answer(0);
    expect(decided).toEqual([]);
  });

  it('says so when the payment already timed out or was decided', async () => {
    const { t, sent, tap } = setup({ result: 'not_waiting' });
    tap(`a:${CALL}`);
    await t.answer(0);
    expect(sent.find((s) => s.method === 'answerCallbackQuery')?.body.text).toMatch(/Too late/);
  });

  it('moves past updates it has seen', async () => {
    const { t, sent, tap } = setup();
    tap(`a:${CALL}`, OWNER, 41);
    await t.answer(0);
    await t.answer(0);
    const polls = sent.filter((s) => s.method === 'getUpdates').map((s) => s.body.offset);
    expect(polls).toEqual([0, 42]);
  });

  it('writes an unknown amount and payee in words', () => {
    const p = held();
    p.call.amount = undefined;
    p.call.counterparty = undefined;
    expect(heldMessage(p)).toContain('an unknown amount to an unknown payee');
  });
});
