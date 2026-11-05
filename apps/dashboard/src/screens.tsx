import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type Call } from './api.js';
import { ago, checkName, forUser, money, STATUS, toolName } from './format.js';
import { Slip } from './slip.js';

const POLL = { refetchInterval: 2000 };

export function Approvals() {
  const q = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, ...POLL });
  const count = q.data?.length ?? 0;
  return (
    <section aria-labelledby="approvals-h" className="space-y-4">
      <h2 id="approvals-h" className="text-lg font-semibold" aria-live="polite">
        {count === 0
          ? 'Nothing is waiting for you'
          : count === 1
            ? 'One payment is waiting for you'
            : `${count} payments are waiting for you`}
      </h2>
      {count === 0 && (
        <p className="text-ink-soft">
          When your agent tries to pay outside what you allowed, it shows up here for you to decide.
        </p>
      )}
      {q.data?.map((a) => (
        <Slip key={a.call.callId} a={a} />
      ))}
    </section>
  );
}

function StatusWord({ c }: { c: Call }) {
  const passive = c.status === 'received' && (c.tier === 'TIER_READ' || c.tier === 'TIER_WRITE');
  const s = STATUS[c.status] ?? { label: c.status, tone: 'text-ink-soft' };
  return (
    <span className={`font-medium ${passive ? 'text-ink-soft' : s.tone}`}>
      {passive ? 'Passed through' : s.label}
    </span>
  );
}

export function Activity({ open }: { open: (id: string) => void }) {
  const q = useQuery({ queryKey: ['calls'], queryFn: api.calls, ...POLL });
  return (
    <section aria-labelledby="activity-h">
      <h2 id="activity-h" className="text-lg font-semibold">
        What your agent did
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-[15px]">
          <thead className="text-sm text-ink-soft">
            <tr className="border-b border-rule">
              <th className="py-2 pr-4 font-normal">When</th>
              <th className="py-2 pr-4 font-normal">Action</th>
              <th className="py-2 pr-4 font-normal">Payee or reference</th>
              <th className="py-2 pr-4 text-right font-normal">Amount</th>
              <th className="py-2 font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((c) => (
              <tr key={c.callId} className="border-b border-rule/70 hover:bg-sheet">
                <td className="py-2 pr-4 text-ink-soft">{ago(c.receivedAt ?? c.updatedAt)}</td>
                <td className="py-2 pr-4">
                  <button
                    type="button"
                    onClick={() => open(c.callId)}
                    className="text-blue underline-offset-2 hover:underline"
                  >
                    {toolName(c.tool ?? 'unknown')}
                  </button>
                </td>
                <td className="max-w-56 py-2 pr-4 [overflow-wrap:anywhere]">
                  {c.counterparty ?? ''}
                </td>
                <td className="py-2 pr-4 text-right">{c.amount ? money(c.amount) : ''}</td>
                <td className="py-2">
                  <StatusWord c={c} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.data?.length === 0 && (
          <p className="py-6 text-ink-soft">Your agent hasn't made any calls yet.</p>
        )}
      </div>
    </section>
  );
}

const STEP: Record<string, string> = {
  callReceived: 'Agent asked',
  approvalRequested: 'Held for your approval',
  approvalResolved: 'Approval answered',
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
      return `${v.approved ? 'Approved' : 'Rejected'} ${via(String(v.resolvedBy ?? ''))}`;
    case 'decisionMade':
      return `${v.outcome === 'OUTCOME_ALLOW' ? 'Allowed' : 'Blocked'}, decided by ${String(
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
        Back to activity
      </button>
      {q.isError && <p className="text-refused">This call isn't in the ledger.</p>}
      {c && (
        <>
          <header>
            <p className="text-sm text-ink-soft">{toolName(c.tool ?? '')}</p>
            <h2 id="evidence-h" className="text-2xl font-semibold tracking-tight">
              {c.amount ? `${money(c.amount)} to ` : ''}
              {c.counterparty ?? 'no payee'}
            </h2>
            <p className="mt-1">
              <StatusWord c={c} />
            </p>
            {(c.reasons ?? []).length > 0 && (
              <p className="mt-3 text-sm font-medium text-held">
                {c.status === 'denied' ? 'Blocked because' : 'Held because'}
              </p>
            )}
            {(c.reasons ?? []).length > 0 && (
              <ul className="mt-1 space-y-1 border-l-2 border-held pl-4">
                {c.reasons?.map((r) => (
                  <li key={r.code}>
                    <span className="font-medium">{checkName(r.check)}:</span> {forUser(r.message)}
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
                    {new Date(e.occurredAt).toLocaleTimeString()} by {e.producer}, ledger entry{' '}
                    {e.seq}, fingerprint {e.hash.slice(0, 12)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {chain.data && (
            <p className={chain.data.ok ? 'text-paid' : 'font-semibold text-refused'}>
              {chain.data.ok
                ? `The ledger is intact: all ${chain.data.entries} entries check out.`
                : `The ledger has been altered, starting at entry ${chain.data.firstBadSeq}.`}
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
      <h1 className="text-3xl font-semibold tracking-tight">Warden</h1>
      <p className="mt-2 text-ink-soft">Sign in to decide on payments your agent wants to make.</p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-sm border border-rule bg-sheet px-3 py-2"
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
          className="w-full rounded-sm bg-ink py-2 font-medium text-sheet disabled:opacity-50"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
