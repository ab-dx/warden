import type { ServiceImpl } from '@connectrpc/connect';
import { type JudgeService, Outcome, Tier } from '@warden/contracts';
import {
  allow,
  amountAboveWhatUserWrote,
  amountToken,
  emailToken,
  payeeOnlyFromUntrusted,
  tighten,
  type Verdict,
} from '@warden/core';
import type { IntentJudge } from './intent.js';
import type { Observed } from './store.js';

export type Seen = (sessionId: string) => Promise<Observed[]>;

const OUTCOMES = { allow: Outcome.ALLOW, escalate: Outcome.ESCALATE, deny: Outcome.DENY } as const;

// where the agent first read a token: "read_email id=msg-1043", or just the tool
function where(read: Observed[], token: string) {
  const r = read.find((x) => x.token === token);
  if (!r) return 'an untrusted tool';
  return r.sourceRef ? `${r.sourceTool} ${r.sourceRef}` : r.sourceTool;
}

export function judgeService(seen: Seen, judge?: IntentJudge): ServiceImpl<typeof JudgeService> {
  return {
    async assess({ intent, mandates }) {
      if (!intent) {
        return {
          outcome: Outcome.DENY,
          reasons: [{ code: 'INVALID_INTENT', message: 'no intent was sent', check: 'judge' }],
        };
      }
      const userText = mandates.flatMap((m) => [m.task, ...m.counterparties]);
      const read = intent.sessionId ? await seen(intent.sessionId) : [];
      const tokens = read.map((r) => r.token);

      let v: Verdict = allow();
      if (payeeOnlyFromUntrusted(intent.counterparty, tokens, userText)) {
        v = {
          outcome: 'escalate',
          reasons: [
            {
              code: 'PAYEE_FROM_UNTRUSTED_CONTENT',
              message: `${intent.counterparty} appears only in content the agent read (${where(read, emailToken(intent.counterparty ?? ''))}), never in anything the user wrote`,
              check: 'provenance',
            },
          ],
        };
      }
      const amount = intent.amount;
      if (amount && amountAboveWhatUserWrote(amount, tokens, userText)) {
        const [whole = '0', frac = ''] = amount.value.split('.');
        v = tighten(v, {
          outcome: 'escalate',
          reasons: [
            {
              code: 'AMOUNT_FROM_UNTRUSTED_CONTENT',
              message: `${amount.value} ${amount.currency} comes from content the agent read (${where(read, amountToken(whole, frac))}) and is more than any amount the user wrote`,
              check: 'provenance',
            },
          ],
        });
      }
      // with no mandate there is no task to judge against, and policy holds the call anyway
      if (judge && intent.tier === Tier.MONEY_OUT && mandates.length > 0)
        v = tighten(v, await judge(intent, mandates, tokens));

      return { outcome: OUTCOMES[v.outcome], reasons: v.reasons };
    },
  };
}
