import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from './api.js';
import { checkName, forUser, money, STATUS, toolName } from './format.js';
import { ActivityGrid } from './grid.js';
import { Slip } from './slip.js';

const POLL = { refetchInterval: 2000 };

// cents from a two-decimal money string, for a share that never touches floats until the end
const cents = (v: string) => BigInt(v.replace('.', ''));

export function Today() {
  const q = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 5000 });
  if (!q.data) return null;
  const t = q.data.today;
  const moved = t.moved.length ? t.moved.map(money).join(' + ') : '$0.00';
  // the demo agent always, others once they have spent something today
  const budgets = q.data.budgets.filter(
    (b) => b.agentId === 'ops-agent' || cents(b.used.value) > 0n,
  );
  const figure = (label: string, value: string | number, tone = '') => (
    <div>
      <p className={`wide text-2xl font-bold ${tone}`}>{value}</p>
      <p className="text-sm text-ink-soft">{label}</p>
    </div>
  );
  return (
    <section aria-label="The last 24 hours" className="space-y-4">
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        {figure('paid out, last 24 hours', moved)}
        {figure('paid', t.completed, 'text-paid')}
        {figure('refused', t.blocked, t.blocked ? 'text-refused' : '')}
        {figure('to countersign', t.waiting, t.waiting ? 'text-held' : '')}
        {t.paypalRefused > 0 && figure('declined by PayPal', t.paypalRefused, 'text-refused')}
      </div>
      {budgets.map((b) => {
        const limit = cents(b.dailyBudget.value);
        const share = limit === 0n ? 0 : Number((cents(b.used.value) * 100n) / limit);
        return (
          <div key={b.agentId} className="max-w-md">
            <p className="text-sm">
              <span className="font-semibold">{b.agentId}</span> has spent {money(b.used)} of its{' '}
              {money(b.dailyBudget)} daily budget
            </p>
            <div
              className="mt-1 h-1.5 bg-rule"
              role="progressbar"
              aria-label={`${b.agentId} daily budget used`}
              aria-valuenow={Math.min(share, 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-1.5 ${share >= 90 ? 'bg-refused' : 'bg-ink'}`}
                style={{ width: `${Math.min(share, 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function Approvals() {
  const q = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, ...POLL });
  const count = q.data?.length ?? 0;
  return (
    <section aria-labelledby="approvals-h" className="space-y-4">
      <h2 id="approvals-h" className="semiwide text-lg font-bold" aria-live="polite">
        {count === 0 ? 'Nothing to countersign' : `To countersign (${count})`}
      </h2>
      {count === 0 && (
        <p className="text-ink-soft">Payments outside a mandate wait here for you.</p>
      )}
      {q.data?.map((a) => (
        <Slip key={a.call.callId} a={a} />
      ))}
    </section>
  );
}

export function Activity({ open }: { open: (id: string) => void }) {
  const q = useQuery({ queryKey: ['calls'], queryFn: api.calls, ...POLL });
  return (
    <section aria-labelledby="activity-h">
      <h2 id="activity-h" className="semiwide text-lg font-bold">
        Activity
      </h2>
      <div className="mt-3">
        <ActivityGrid rows={q.data} open={open} />
      </div>
    </section>
  );
}

const STEP: Record<string, string> = {
  callReceived: 'Agent asked',
  approvalRequested: 'Held for countersignature',
  approvalResolved: 'Owner answered',
  decisionMade: 'Warden decided',
  paymentExecuted: 'Sent to PayPal',
  reservationReleased: 'Budget hold released',
};

// "dashboard:owner" or "telegram:12345" as the owner would say it
function via(by: string) {
  const [where, who] = by.split(':');
  if (where === 'dashboard') return `by ${who} on the dashboard`;
  if (where === 'telegram') return 'from Telegram';
  return `by ${by}`;
}

function stepDetail(type: string, dataJson: string): string {
  const d = JSON.parse(dataJson) as Record<string, Record<string, unknown>>;
  const v = d[type] ?? {};
  switch (type) {
    case 'approvalResolved':
      return `${v.approved ? 'Countersigned' : 'Refused'} ${via(String(v.resolvedBy ?? ''))}${v.receipt ? ', signed receipt kept' : ''}`;
    case 'decisionMade':
      return `${v.outcome === 'OUTCOME_ALLOW' ? 'Allowed' : 'Refused'} by ${String(
        v.decidedBy ?? 'policy',
      )
        .replace('DECIDED_BY_', '')
        .toLowerCase()}`;
    case 'paymentExecuted':
      return v.ok
        ? `PayPal accepted it (${String(v.upstreamRef ?? '')})`
        : `PayPal did not complete it (${String(v.errorCode ?? '')})`;
    case 'reservationReleased':
      return v.reason ? forUser(String(v.reason)) : '';
    default:
      return '';
  }
}

export function Evidence({ id, back }: { id: string; back: () => void }) {
  const q = useQuery({ queryKey: ['call', id], queryFn: () => api.call(id), ...POLL });
  const chain = useQuery({ queryKey: ['verify'], queryFn: api.verify });
  const c = q.data?.call;
  return (
    <section aria-labelledby="evidence-h" className="space-y-6">
      <button type="button" onClick={back} className="text-blue hover:underline">
        Activity
      </button>
      {q.isError && <p className="text-refused">No call {id} in the ledger.</p>}
      {c && (
        <>
          <header>
            <p className="text-sm text-ink-soft">{toolName(c.tool ?? '')}</p>
            <h2 id="evidence-h" className="semiwide text-2xl font-bold [overflow-wrap:anywhere]">
              {c.amount ? `${money(c.amount)} to ` : ''}
              {c.counterparty ?? 'no payee'}
            </h2>
            <p className="mt-4">
              <span className={`stamp text-2xl ${STATUS[c.status]?.tone ?? 'text-ink-soft'}`}>
                {STATUS[c.status]?.label ?? c.status}
              </span>
            </p>
            {(c.reasons ?? []).length > 0 && (
              <p
                className={`mt-4 text-sm font-semibold ${c.status === 'denied' ? 'text-refused' : 'text-held'}`}
              >
                {c.status === 'denied' ? 'Refused because' : 'Held because'}
              </p>
            )}
            {(c.reasons ?? []).length > 0 && (
              <ul
                className={`mt-1 space-y-1 border-l-2 pl-4 ${c.status === 'denied' ? 'border-refused' : 'border-held'}`}
              >
                {c.reasons?.map((r) => (
                  <li key={r.code}>
                    <span className="font-semibold">{checkName(r.check)}:</span>{' '}
                    {forUser(r.message)}
                  </li>
                ))}
              </ul>
            )}
          </header>
          <ol className="space-y-0">
            {q.data?.entries.map((e, i) => (
              <li key={e.seq} className="grid grid-cols-[2rem_1fr] gap-3 border-t border-rule py-3">
                <span className="text-ink-soft">{i + 1}</span>
                <div>
                  <p className="font-medium">{STEP[e.type] ?? e.type}</p>
                  <p className="text-[15px]">{stepDetail(e.type, e.dataJson)}</p>
                  <p className="mt-1 text-sm text-ink-soft">
                    {new Date(e.occurredAt).toLocaleTimeString()}, {e.producer}, entry {e.seq}, hash{' '}
                    {e.hash.slice(0, 12)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {chain.data && (
            <p className={chain.data.ok ? 'text-paid' : 'font-semibold text-refused'}>
              {chain.data.ok
                ? `Ledger verified: ${chain.data.entries} entries, chain unbroken.`
                : `Ledger altered at entry ${chain.data.firstBadSeq}. Every hash after it is wrong.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function Login() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.login(password),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="wide flex items-center gap-3 text-3xl font-extrabold">
        <img src="/mark.svg" alt="" width={40} height={40} />
        Warden
      </h1>
      <form onSubmit={submit} className="mt-8 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full border border-rule bg-sheet px-3 py-2"
          />
        </label>
        {login.isError && (
          <p role="alert" className="text-sm text-refused">
            {(login.error as Error).message}
          </p>
        )}
        <button
          type="submit"
          disabled={login.isPending}
          className="semiwide w-full bg-ink py-2 font-semibold text-sheet disabled:opacity-50"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
