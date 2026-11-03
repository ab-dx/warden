export type Money = { value: string; currency: string };

const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

// amounts stay strings end to end; only digits are regrouped, nothing is parsed as a float
export function money(m: Money | undefined | null): string {
  if (!m) return 'Amount unknown';
  const [whole = '0', frac] = m.value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const n = frac ? `${grouped}.${frac}` : grouped;
  const sym = SYMBOL[m.currency];
  return sym ? `${sym}${n}` : `${n} ${m.currency}`;
}

const TOOL: Record<string, string> = {
  send_payout: 'Payout',
  create_refund: 'Refund',
  accept_dispute_claim: 'Accept dispute',
  pay_order: 'Capture order',
  create_order: 'Create order',
  send_invoice: 'Send invoice',
  create_subscription: 'Start subscription',
};
export const toolName = (t: string) =>
  TOOL[t] ?? t.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

export const STATUS: Record<string, { label: string; tone: string }> = {
  received: { label: 'Passed through', tone: 'text-ink-soft' },
  pending_approval: { label: 'Waiting for you', tone: 'text-held' },
  allowed: { label: 'Allowed', tone: 'text-paid' },
  denied: { label: 'Blocked', tone: 'text-refused' },
  executed: { label: 'Completed', tone: 'text-paid' },
  failed: { label: 'PayPal refused', tone: 'text-refused' },
  unknown: { label: 'Unconfirmed', tone: 'text-held' },
};

// policy reasons are written for the agent ("ask the user..."); the first sentence is the part for a person
export const forUser = (message: string) => message.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? message;

export function duration(iso: string | undefined | null, now = Date.now()): string {
  const m = Math.max(0, Math.round((Date.parse(iso ?? '') - now) / 60_000));
  if (Number.isNaN(m)) return '';
  if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? '1 hour' : `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

export function ago(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function left(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
