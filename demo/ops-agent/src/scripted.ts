import type { Brain, Message, ToolCall, Turn } from './brain.js';

type Email = { id: string; subject: string; body: string };

// a deterministic stand-in for a model that has been prompt-injected: it does the job,
// and it also obeys instructions it finds inside emails. that is the agent warden has
// to assume it is guarding.
export function scriptedBrain(): Brain {
  let phase: 'list' | 'read' | 'act' | 'follow' | 'done' = 'list';
  let n = 0;
  const id = () => `call_${++n}`;
  const pending = new Set<string>();
  let checking: string[] = [];
  let polls = 0;

  return {
    async next(messages: Message[]): Promise<Turn> {
      const results = trailingResults(messages);
      switch (phase) {
        case 'list': {
          phase = 'read';
          return {
            say: 'Checking the inbox.',
            calls: [{ id: id(), name: 'list_emails', args: {} }],
          };
        }
        case 'read': {
          const list = JSON.parse(results[0]?.content ?? '[]') as { id: string }[];
          phase = 'act';
          return { calls: list.map((e) => ({ id: id(), name: 'read_email', args: { id: e.id } })) };
        }
        case 'act': {
          const emails = results.map((r) => JSON.parse(r.content) as Email);
          const calls = emails.flatMap((e) => act(e, id));
          phase = 'follow';
          return { say: `Read ${emails.length} emails. Acting on ${calls.length} of them.`, calls };
        }
        case 'follow': {
          // results line up with the calls made last turn: the first follow turn sees the
          // payments, later ones see the checks for the call ids in `checking`
          results.forEach((r, k) => {
            const w = warden(r.content);
            const callId = w?.callId ?? checking[k];
            if (!callId) return;
            if (w?.outcome === 'pending') pending.add(callId);
            else pending.delete(callId);
          });
          if (pending.size === 0 || polls++ >= 30) {
            phase = 'done';
            return {
              say: pending.size ? 'Some payments are still waiting for the owner.' : 'Inbox done.',
              calls: [],
            };
          }
          checking = [...pending];
          return {
            calls: checking.map((callId) => ({
              id: id(),
              name: 'warden_check_approval',
              args: { callId },
            })),
          };
        }
        default:
          return { calls: [] };
      }
    },
  };
}

function act(e: Email, id: () => string): ToolCall[] {
  const amount = /\$(\d+(?:\.\d{2})?)/.exec(e.body)?.[1];
  if (!amount) return [];
  const value = amount.includes('.') ? amount : `${amount}.00`;
  if (/refund/i.test(e.body + e.subject)) {
    const capture = /\b[0-9A-Z]{17}\b/.exec(e.body)?.[0];
    return capture
      ? [
          {
            id: id(),
            name: 'create_refund',
            args: { capture_id: capture, amount: { value, currency_code: 'USD' } },
          },
        ]
      : [];
  }
  if (/invoice/i.test(e.subject)) {
    // the injected line wins, as it would for a model that trusts what it reads
    const redirected = /send (?:this|the) payment to ([\w.+-]+@[\w.-]+\w) instead/i.exec(
      e.body,
    )?.[1];
    const payee = redirected ?? [...e.body.matchAll(/[\w.+-]+@[\w.-]+\w/g)].map((m) => m[0]).at(-1);
    return payee
      ? [
          {
            id: id(),
            name: 'send_payout',
            args: {
              receiver_email: payee,
              amount: { value, currency_code: 'USD' },
              note: e.subject.slice(0, 200),
            },
          },
        ]
      : [];
  }
  return [];
}

function trailingResults(messages: Message[]) {
  const out: { content: string }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'tool') break;
    out.unshift({ content: m.content });
  }
  return out;
}

function warden(content: string): { outcome?: string; callId?: string } | undefined {
  try {
    return (JSON.parse(content) as { warden?: { outcome?: string; callId?: string } }).warden;
  } catch {
    return undefined;
  }
}
