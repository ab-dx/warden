import type { CallSummary } from '@warden/contracts';
import type { Decided } from './approvals.js';

// one bot api method call: https://core.telegram.org/bots/api
export type Bot = (method: string, body: object) => Promise<unknown>;

export function botApi(token: string, timeoutMs = 35_000): Bot {
  return async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    // never put the url in an error, it carries the token
    if (!out.ok) throw new Error(`telegram ${method} failed: ${out.description ?? res.status}`);
    return out.result;
  };
}

type Pending = { call: CallSummary; expiresAt?: string | undefined };
type Update = {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
  };
};

export function heldMessage(p: Pending) {
  const c = p.call;
  const amount = c.amount ? `${c.amount.value} ${c.amount.currency}` : 'an unknown amount';
  const why = c.reasons.map((r) => `- ${r.message}`).join('\n');
  const until = p.expiresAt
    ? `\nBlocked if nobody answers by ${p.expiresAt.slice(11, 16)} UTC.`
    : '';
  return `Warden is holding a payment for you.\n\n${c.tool}: ${amount} to ${c.counterparty ?? 'an unknown payee'}\n\nWhy:\n${why}${until}`;
}

// asks the owner about each held payment in one chat and turns their tap into the same
// decision the dashboard makes. taps from any other chat are ignored
export function telegramApprovals(opts: {
  bot: Bot;
  chatId: number;
  pending: () => Promise<Pending[]>;
  decide: (callId: string, approved: boolean, by: string) => Promise<Decided>;
}) {
  // shortcut: kept in memory, so a restart asks again about payments still held. fine for
  // one owner; move to the ledger if more than one api instance runs
  const asked = new Set<string>();
  let offset = 0;

  async function notify() {
    for (const p of await opts.pending()) {
      if (asked.has(p.call.callId)) continue;
      await opts.bot('sendMessage', {
        chat_id: opts.chatId,
        text: heldMessage(p),
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: `a:${p.call.callId}` },
              { text: 'Reject', callback_data: `r:${p.call.callId}` },
            ],
          ],
        },
      });
      asked.add(p.call.callId);
    }
  }

  async function answer(waitSeconds: number) {
    const updates = (await opts.bot('getUpdates', {
      offset,
      timeout: waitSeconds,
      allowed_updates: ['callback_query'],
    })) as Update[];
    for (const u of updates) {
      offset = u.update_id + 1;
      const q = u.callback_query;
      if (!q?.message || q.message.chat.id !== opts.chatId) continue;
      const m = /^([ar]):(c_[0-9a-f-]{36})$/.exec(q.data ?? '');
      if (!m?.[2]) continue;
      const approved = m[1] === 'a';
      const r = await opts.decide(m[2], approved, `telegram:${q.from.username ?? q.from.id}`);
      const result =
        r === 'sent'
          ? approved
            ? 'Approved.'
            : 'Rejected.'
          : 'Too late, this payment is no longer waiting.';
      await opts.bot('answerCallbackQuery', { callback_query_id: q.id, text: result });
      await opts.bot('editMessageReplyMarkup', {
        chat_id: opts.chatId,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: result, callback_data: 'done' }]] },
      });
    }
  }

  return { notify, answer };
}

// runs both loops until the process ends. a failure is logged and retried, never fatal:
// the dashboard still works without telegram, and an unanswered hold times out to a deny
export function startTelegram(
  t: ReturnType<typeof telegramApprovals>,
  log: (msg: string) => void,
  pollMs = 2000,
) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const loop = async (step: () => Promise<void>, pause: number) => {
    for (;;) {
      try {
        await step();
      } catch (err) {
        log((err as Error).message);
        await sleep(5000);
      }
      await sleep(pause);
    }
  };
  void loop(t.notify, pollMs);
  void loop(() => t.answer(25), 0);
}
