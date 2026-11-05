import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Brain, Message, ToolSpec } from './brain.js';

export type Endpoint = { url: string; headers?: Record<string, string> };
export type Log = (line: string) => void;

const text = (r: Record<string, unknown>) =>
  ((r.content as { type: string; text?: string }[] | undefined) ?? [])
    .map((c) => c.text ?? '')
    .join('\n');

// who and how much, for money calls: the part a viewer needs to see
function label(name: string, args: Record<string, unknown>): string {
  if (name === 'read_email') return `read_email ${args.id}`;
  const amount = (args.amount as { value?: unknown } | undefined)?.value;
  const to = args.receiver_email ?? args.capture_id ?? args.dispute_id;
  if (typeof to !== 'string') return name;
  return `${name} ${typeof amount === 'string' ? `$${amount} ` : ''}to ${to}`;
}

// one line per step, so a run reads like a story in the terminal and in the video
function summarise(out: string): string {
  try {
    const b = JSON.parse(out);
    if (b?.warden) return `${b.warden.outcome} ${b.warden.code}: ${b.warden.message}`;
    if (Array.isArray(b)) return `${b.length} items`;
    return `ok ${b.id ?? b.payout_batch_id ?? b.subject ?? ''}`.trim();
  } catch {
    return out.slice(0, 120);
  }
}

// what an operations assistant needs for the inbox jobs, out of the ~30 tools paypal and
// warden offer. every tool's schema goes out on every model step, so the full list costs
// more tokens than the conversation itself
export const AGENT_TOOLS = [
  'list_emails',
  'read_email',
  'send_payout',
  'create_refund',
  'accept_dispute_claim',
  'get_capture',
  'get_order',
  'list_transactions',
  'list_invoices',
  'get_invoice',
  'warden_check_approval',
] as const;

export async function runAgent(opts: {
  brain: Brain;
  endpoints: Endpoint[];
  system: string;
  task: string;
  log: Log;
  maxSteps?: number;
  // only offer these tools to the model; all of them when unset
  tools?: readonly string[];
  pollMs?: number;
  // sees every tool call and its result, for the benchmark
  onCall?: (call: { name: string; args: Record<string, unknown>; out: string; ms: number }) => void;
}) {
  const routes = new Map<string, Client>();
  const tools: ToolSpec[] = [];
  for (const ep of opts.endpoints) {
    const client = new Client({ name: 'ops-agent', version: '0.1.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(ep.url), {
        requestInit: { headers: ep.headers ?? {} },
      }),
    );
    for (const t of (await client.listTools()).tools) {
      if (opts.tools && !opts.tools.includes(t.name)) continue;
      routes.set(t.name, client);
      tools.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      });
    }
  }

  const messages: Message[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.task },
  ];
  for (let step = 0; step < (opts.maxSteps ?? 25); step++) {
    const turn = await opts.brain.next(messages, tools);
    if (turn.say) opts.log(`agent: ${turn.say}`);
    messages.push({
      role: 'assistant',
      content: turn.say ?? null,
      ...(turn.calls.length
        ? {
            tool_calls: turn.calls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : {}),
    });
    if (turn.calls.length === 0) {
      await Promise.all([...new Set(routes.values())].map((c) => c.close()));
      return messages;
    }

    // checking on a held payment right away just burns calls; give the owner a moment
    if (turn.calls.some((c) => c.name === 'warden_check_approval'))
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
    for (const call of turn.calls) {
      const client = routes.get(call.name);
      const started = Date.now();
      const out = client
        ? text(await client.callTool({ name: call.name, arguments: call.args }))
        : `no tool named ${call.name}`;
      opts.onCall?.({ name: call.name, args: call.args, out, ms: Date.now() - started });
      opts.log(`  ${label(call.name, call.args).padEnd(22)} ${summarise(out)}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  opts.log('agent: stopped after the step limit');
  await Promise.all([...new Set(routes.values())].map((c) => c.close()));
  return messages;
}
