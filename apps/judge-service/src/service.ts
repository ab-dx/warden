import type { ServiceImpl } from '@connectrpc/connect';
import { type JudgeService, Outcome } from '@warden/contracts';
import { payeeOnlyFromUntrusted } from '@warden/core';

export type Seen = (sessionId: string) => Promise<string[]>;

export function judgeService(seen: Seen): ServiceImpl<typeof JudgeService> {
  return {
    async assess({ intent, mandates }) {
      if (!intent) {
        return {
          outcome: Outcome.DENY,
          reasons: [{ code: 'INVALID_INTENT', message: 'no intent was sent', check: 'judge' }],
        };
      }
      const userText = mandates.flatMap((m) => [m.task, ...m.counterparties]);
      const tokens = intent.sessionId ? await seen(intent.sessionId) : [];
      if (payeeOnlyFromUntrusted(intent.counterparty, tokens, userText)) {
        return {
          outcome: Outcome.ESCALATE,
          reasons: [
            {
              code: 'PAYEE_FROM_UNTRUSTED_CONTENT',
              message: `${intent.counterparty} appears only in content the agent read, never in anything the user wrote`,
              check: 'provenance',
            },
          ],
        };
      }
      return { outcome: Outcome.ALLOW, reasons: [] };
    },
  };
}
