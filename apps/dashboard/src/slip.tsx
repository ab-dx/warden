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

  const serial = call.callId.replace(/^c_/, '').slice(0, 6).toUpperCase();

  return (
    <article
      className="grid border border-rule bg-sheet sm:grid-cols-[1fr_1rem_9.5rem]"
      aria-labelledby={`pay-${call.callId}`}
    >
      <div className="min-w-0">
        <div className="guilloche h-3 border-b border-rule" aria-hidden="true" />
        <div className="grid gap-x-8 gap-y-3 px-6 pt-5 pb-4 sm:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <p className="text-sm text-ink-soft">{toolName(call.tool ?? '')} to</p>
            <h3
              id={`pay-${call.callId}`}
              className="semiwide mt-0.5 text-xl font-semibold [overflow-wrap:anywhere]"
            >
              {call.counterparty ?? 'an unknown payee'}
            </h3>
          </div>
          <p className="wide self-end border-b-[3px] border-double border-ink pb-0.5 text-right text-3xl font-bold">
            {money(call.amount)}
          </p>
        </div>

        {a.trail && (a.trail.reads.length > 0 || a.trail.paidBy) && (
          <PaperTrail a={a} trail={a.trail} now={now} />
        )}

        <div className="border-t border-rule px-6 py-4">
          <p className="text-sm font-semibold text-held">Held because</p>
          <ul className="mt-1 space-y-1 text-[15px] leading-relaxed">
            {(call.reasons ?? []).map((r) => (
              <li key={r.code}>
                <span className="font-semibold">{checkName(r.check)}:</span> {forUser(r.message)}
              </li>
            ))}
          </ul>
          {a.brief && (
            <p className="mt-3 text-[15px] leading-relaxed">
              <span className="font-semibold">Note:</span> {a.brief}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-rule px-6 py-4">
          <div className="min-w-48 flex-1 text-sm text-ink-soft">
            <p>
              {call.agentId ?? 'An agent'} asked {ago(a.requestedAt, now)}. Refused automatically in{' '}
              {left(a.expiresAt, now)}.
            </p>
            <div className="mt-2 h-1 bg-rule" aria-hidden="true">
              <div className="countdown h-1 bg-held" style={{ width: `${remaining * 100}%` }} />
            </div>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={decide.isPending}
              onClick={() => decide.mutate(false)}
              className="border border-refused px-4 py-2 font-medium text-refused hover:bg-refused/5 disabled:opacity-50"
            >
              Refuse
            </button>
            <button
              type="button"
              disabled={decide.isPending}
              onClick={() => decide.mutate(true)}
              className="semiwide bg-ink px-4 py-2 font-semibold text-sheet hover:bg-ink/90 disabled:opacity-50"
            >
              {a.needsPasskey ? 'Countersign with passkey' : 'Countersign'}
            </button>
          </div>
        </div>
        {decide.isError && (
          <p role="alert" className="border-t border-rule px-6 py-3 text-sm text-refused">
            {(decide.error as Error).message}
          </p>
        )}
      </div>

      <div className="perforation min-h-4" aria-hidden="true" />

      {/* the counterfoil: what stays with the owner once the cheque is torn off */}
      <aside className="flex flex-row items-center justify-between gap-3 px-5 py-4 sm:flex-col sm:items-start sm:justify-start">
        <p className="text-sm text-ink-soft">
          No. <span className="semiwide font-semibold text-ink">{serial}</span>
        </p>
        <p className="wide text-lg font-bold">{money(call.amount)}</p>
        <span className="stamp stamp-in text-2xl text-held sm:mt-5">Held</span>
      </aside>
    </article>
  );
}

const Step = ({ children, last }: { children: React.ReactNode; last?: boolean }) => (
  <li className="relative pl-6">
    {!last && (
      <span className="absolute top-4 bottom-[-12px] left-[5px] w-px bg-rule" aria-hidden="true" />
    )}
    <span
      className="absolute top-[7px] left-0 h-[11px] w-[11px] rounded-full border-2 border-ink bg-sheet"
      aria-hidden="true"
    />
    {children}
  </li>
);

// "read_email" + "id=msg-1043" as a person would say it
function readName(tool: string, ref: string) {
  const id = ref.replace(/^id=/, '');
  if (tool === 'read_email') return `Email ${id}`;
  return [toolName(tool), id].filter(Boolean).join(' ');
}

const listed = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

// where the payment came from: what the agent read, what it asked for, what held it
function PaperTrail({ a, trail, now }: { a: Approval; trail: Trail; now: number }) {
  const { call } = a;
  const held = [...new Set((call.reasons ?? []).map((r) => checkName(r.check)))];
  return (
    <div className="border-t border-rule px-6 py-4">
      <p className="text-sm font-semibold">Paper trail</p>
      <ol className="mt-2 space-y-3 text-[15px] leading-relaxed">
        {trail.reads.map((r) => (
          <Step key={`${r.tool}-${r.ref}-${r.at}`}>
            <span className="font-medium">{readName(r.tool, r.ref)}</span>{' '}
            <span className="text-ink-soft">{ago(r.at, now)}</span>
            <div className="text-held">
              Had this {listed([r.payee ? 'payee' : '', r.amount ? 'amount' : ''].filter(Boolean))}
            </div>
          </Step>
        ))}
        <Step>
          The agent asked for a {toolName(call.tool ?? '').toLowerCase()} of {money(call.amount)}
          {trail.paidBy && (
            <div className="text-sm text-ink-soft">
              PayPal says the original payment came from{' '}
              <span className="font-medium text-ink">{trail.paidBy}</span>.
            </div>
          )}
        </Step>
        <Step last>Held by {held.length ? listed(held) : 'Warden'}</Step>
      </ol>
    </div>
  );
}
