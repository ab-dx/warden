import { startAuthentication } from '@simplewebauthn/browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type Approval, api, type Trail } from './api.js';
import { ago, checkName, forUser, left, money, toolName } from './format.js';

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// a held payment, laid out like a cheque waiting for a signature
export function Slip({ a }: { a: Approval }) {
  const qc = useQueryClient();
  const now = useNow();
  const decide = useMutation({
    mutationFn: async (approved: boolean) => {
      if (!approved || !a.needsPasskey) return api.decide(a.call.callId, approved);
      // big approvals: the owner proves it's them, for this payment only
      const optionsJSON = await api.approvalChallenge(a.call.callId);
      return api.decide(a.call.callId, true, await startAuthentication({ optionsJSON }));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['calls'] });
    },
  });
  const { call } = a;
  const start = a.requestedAt ? Date.parse(a.requestedAt) : now;
  const end = a.expiresAt ? Date.parse(a.expiresAt) : now;
  const remaining = end > start ? Math.max(0, Math.min(1, (end - now) / (end - start))) : 0;

  return (
    <article
      className="security-paper rounded-sm border border-rule shadow-[0_1px_0_var(--color-rule)]"
      aria-labelledby={`pay-${call.callId}`}
    >
      <div className="grid gap-x-8 gap-y-4 p-6 sm:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <p className="text-sm text-ink-soft">{toolName(call.tool ?? '')} to</p>
          <h3
            id={`pay-${call.callId}`}
            className="mt-1 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]"
          >
            {call.counterparty ?? 'an unknown payee'}
          </h3>
        </div>
        <p className="self-end border-b-2 border-ink pb-1 text-right text-4xl font-semibold tracking-tight">
          {money(call.amount)}
        </p>
      </div>

      {a.trail && (a.trail.reads.length > 0 || a.trail.paidBy) && (
        <PaperTrail a={a} trail={a.trail} now={now} />
      )}

      <div className="border-t border-rule px-6 py-4">
        <p className="text-sm font-medium text-held">Held because</p>
        <ul className="mt-1 space-y-1 text-[15px] leading-relaxed">
          {(call.reasons ?? []).map((r) => (
            <li key={r.code}>
              <span className="font-medium">{checkName(r.check)}:</span> {forUser(r.message)}
            </li>
          ))}
        </ul>
        {a.brief && (
          <p className="mt-3 text-[15px] leading-relaxed">
            <span className="font-medium">Warden's read:</span> {a.brief}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-rule px-6 py-4">
        <div className="min-w-48 flex-1 text-sm text-ink-soft">
          <p>
            Asked by {call.agentId ?? 'an agent'} {ago(a.requestedAt, now)}. Blocked automatically
            in {left(a.expiresAt, now)}.
          </p>
          <div className="mt-2 h-1 rounded-full bg-rule" aria-hidden="true">
            <div
              className="countdown h-1 rounded-full bg-held"
              style={{ width: `${remaining * 100}%` }}
            />
          </div>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate(false)}
            className="rounded-sm border border-refused px-4 py-2 font-medium text-refused hover:bg-refused/5 disabled:opacity-50"
          >
            Reject payment
          </button>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate(true)}
            className="rounded-sm bg-ink px-4 py-2 font-medium text-sheet hover:bg-ink/90 disabled:opacity-50"
          >
            {a.needsPasskey ? 'Approve with passkey' : 'Approve payment'}
          </button>
        </div>
      </div>
      {decide.isError && (
        <p role="alert" className="border-t border-rule px-6 py-3 text-sm text-refused">
          {(decide.error as Error).message}
        </p>
      )}
    </article>
  );
}

const Step = ({ children, last }: { children: React.ReactNode; last?: boolean }) => (
  <li className="relative pl-6">
    {!last && (
      <span className="absolute left-[5px] top-4 bottom-[-12px] w-px bg-rule" aria-hidden="true" />
    )}
    <span
      className="absolute left-0 top-[7px] h-[11px] w-[11px] rounded-full border-2 border-ink bg-sheet"
      aria-hidden="true"
    />
    {children}
  </li>
);

const Tag = ({ children }: { children: React.ReactNode }) => (
  <span className="ml-2 rounded-sm bg-held/10 px-1.5 py-0.5 text-xs font-medium text-held">
    {children}
  </span>
);

// where the payment came from, step by step: what the agent read, what it asked for, who held it
function PaperTrail({ a, trail, now }: { a: Approval; trail: Trail; now: number }) {
  const { call } = a;
  const held = [...new Set((call.reasons ?? []).map((r) => checkName(r.check)))];
  return (
    <div className="border-t border-rule px-6 py-4">
      <p className="text-sm font-medium text-ink-soft">Paper trail</p>
      <ol className="mt-2 space-y-3 text-[15px] leading-relaxed">
        {trail.reads.map((r) => (
          <Step key={`${r.tool}-${r.ref}-${r.at}`}>
            The agent read{' '}
            <code className="font-mono text-sm">{[r.tool, r.ref].filter(Boolean).join(' ')}</code>
            <span className="text-sm text-ink-soft"> · {ago(r.at, now)}</span>
            <div>
              {r.payee && <Tag>has this payee</Tag>}
              {r.amount && <Tag>has this amount</Tag>}
            </div>
          </Step>
        ))}
        <Step>
          It asked for a {toolName(call.tool ?? '').toLowerCase()} of {money(call.amount)} to{' '}
          <span className="font-medium [overflow-wrap:anywhere]">
            {call.counterparty ?? 'an unknown payee'}
          </span>
          {trail.paidBy && (
            <div className="text-sm text-ink-soft">
              PayPal says the original payment came from{' '}
              <span className="font-medium text-ink">{trail.paidBy}</span>.
            </div>
          )}
        </Step>
        <Step last>Held by {held.length ? held.join(', ') : 'Warden'}, waiting for you.</Step>
      </ol>
    </div>
  );
}
