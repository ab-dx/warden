import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { create } from '@bufbuild/protobuf';
import { MandateSchema, PaymentIntentSchema, Tier } from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import { breaker, chatCompletions, intentJudge, prompt, verdictFrom } from './intent.js';

const intent = create(PaymentIntentSchema, {
  tool: 'send_payout',
  tier: Tier.MONEY_OUT,
  counterparty: 'new-bank@attacker.example',
  amount: { value: '96.00', currency: 'USD' },
});
const mandates = [
  create(MandateSchema, {
    task: 'pay approved contractor invoices',
    counterparties: ['arjun@mehta.example'],
    maxPerCall: { value: '100.00', currency: 'USD' },
  }),
];
const said = (o: object) => JSON.stringify(o);

describe('verdictFrom', () => {
  it('allows a confident yes', () => {
    expect(verdictFrom(said({ serves_task: true, confidence: 0.9, reason: 'ok' }), 0.7)).toEqual({
      outcome: 'allow',
      reasons: [],
    });
  });

  it('holds a no, or an unsure yes, for the owner instead of denying', () => {
    const no = verdictFrom(
      said({ serves_task: false, confidence: 0.95, reason: 'new payee' }),
      0.7,
    );
    expect(no).toMatchObject({ outcome: 'escalate', reasons: [{ code: 'JUDGE_GOAL_MISMATCH' }] });
    const unsure = verdictFrom(said({ serves_task: true, confidence: 0.4, reason: 'hm' }), 0.7);
    expect(unsure.reasons[0]?.code).toBe('JUDGE_LOW_CONFIDENCE');
  });

  it('denies anything it cannot read', () => {
    for (const text of ['not json', said({ serves_task: 'yes' }), said({ confidence: 2 })])
      expect(verdictFrom(text, 0.7)).toMatchObject({
        outcome: 'deny',
        reasons: [{ code: 'CHECK_FAILED' }],
      });
  });
});

describe('prompt', () => {
  it("separates the owner's words from what the agent chose and saw", () => {
    const p = JSON.parse(
      prompt(intent, mandates, ['email:new-bank@attacker.example', 'amount:96.00']),
    );
    expect(p.owner_instructions[0]).toMatchObject({ allowed_payees: ['arjun@mehta.example'] });
    expect(p.payment).toMatchObject({ payee: 'new-bank@attacker.example', amount: '96.00 USD' });
    expect(p.assistant_read_in_untrusted_content).toEqual({ payee: true, amount: true });
  });
});

describe('breaker', () => {
  it('stops calling after repeated failures and tries again after the cooldown', async () => {
    let t = 0;
    let calls = 0;
    const run = breaker({ failures: 2, cooldownMs: 1000, now: () => t });
    const fail = () => {
      calls++;
      return Promise.reject(new Error('down'));
    };
    await expect(run(fail)).rejects.toThrow('down');
    await expect(run(fail)).rejects.toThrow('down');
    await expect(run(fail)).rejects.toThrow('circuit open');
    expect(calls).toBe(2);
    t = 1001;
    expect(await run(async () => 'back')).toBe('back');
  });
});

describe('intentJudge', () => {
  it('denies when the model is unreachable', async () => {
    const judge = intentJudge({
      complete: () => Promise.reject(new Error('timeout')),
      minConfidence: 0.7,
    });
    expect(await judge(intent, mandates, [])).toMatchObject({
      outcome: 'deny',
      reasons: [{ code: 'CHECK_FAILED', check: 'judge' }],
    });
  });

  it('talks to an openai-compatible endpoint', async () => {
    let body: { model?: string; temperature?: number; messages?: unknown[] } = {};
    const http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('content-type', 'application/json');
      res.end(
        said({
          choices: [
            {
              message: {
                content: said({ serves_task: false, confidence: 0.9, reason: 'payee not named' }),
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((r) => http.listen(0, r));
    const url = `http://localhost:${(http.address() as AddressInfo).port}/v1`;
    try {
      const judge = intentJudge({
        complete: chatCompletions({ baseUrl: url, model: 'm', timeoutMs: 2000 }),
        minConfidence: 0.7,
      });
      expect((await judge(intent, mandates, [])).reasons[0]?.code).toBe('JUDGE_GOAL_MISMATCH');
      expect(body).toMatchObject({ model: 'm', temperature: 0 });
      expect(body.messages).toHaveLength(2);
    } finally {
      http.closeAllConnections();
      http.close();
    }
  });
});
