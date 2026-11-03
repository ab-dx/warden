import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Message } from './brain.js';
import { loadScenario } from './scenario.js';
import { scriptedBrain } from './scripted.js';

const scenario = loadScenario(fileURLToPath(new URL('../scenarios/priya.json', import.meta.url)), {
  contractor: 'arjun@personal.example.com',
  capture: '6PX03811AJ271004S',
});
const tool = (content: unknown): Message => ({
  role: 'tool',
  tool_call_id: 'x',
  content: JSON.stringify(content),
});

async function actOnInbox() {
  const brain = scriptedBrain();
  const msgs: Message[] = [];
  await brain.next(msgs, []);
  msgs.push(tool(scenario.emails.map(({ id }) => ({ id }))));
  await brain.next(msgs, []);
  msgs.push(...scenario.emails.map(tool));
  return { brain, msgs, turn: await brain.next(msgs, []) };
}

describe('scripted brain', () => {
  it('pays invoices and follows the hidden redirect, like an injected model would', async () => {
    const { turn } = await actOnInbox();
    const payouts = turn.calls
      .filter((c) => c.name === 'send_payout')
      .map((c) => [c.args.receiver_email, (c.args.amount as { value: string }).value]);
    expect(payouts).toEqual([
      ['arjun@personal.example.com', '40.00'],
      ['new-bank@attacker.example', '96.00'],
      ['arjun@personal.example.com', '120.00'],
    ]);
  });

  it('asks for the refund the customer described', async () => {
    const { turn } = await actOnInbox();
    expect(turn.calls.find((c) => c.name === 'create_refund')?.args).toEqual({
      capture_id: '6PX03811AJ271004S',
      amount: { value: '45.00', currency_code: 'USD' },
    });
  });

  it('keeps checking held payments until they are settled', async () => {
    const { brain, msgs } = await actOnInbox();
    const turn = (...results: Message[]) =>
      msgs.push({ role: 'assistant', content: null }, ...results);
    turn(tool({ warden: { outcome: 'pending', callId: 'c_1' } }), tool({ id: 'B1' }));
    const check = await brain.next(msgs, []);
    expect(check.calls).toEqual([
      expect.objectContaining({ name: 'warden_check_approval', args: { callId: 'c_1' } }),
    ]);
    // a finished payment comes back as paypal's own result, with no warden wrapper
    turn(tool({ id: 'REFUND1', status: 'COMPLETED' }));
    expect((await brain.next(msgs, [])).calls).toEqual([]);
  });
});
