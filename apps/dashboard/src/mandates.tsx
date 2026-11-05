import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type Mandate } from './api.js';
import { duration, money, toolName } from './format.js';

const TOOLS = [
  'send_payout',
  'create_refund',
  'accept_dispute_claim',
  'pay_order',
  'create_order',
  'send_invoice',
  'create_subscription',
];
const DURATIONS: [number, string][] = [
  [60, '1 hour'],
  [240, '4 hours'],
  [720, '12 hours'],
  [1440, '1 day'],
  [10080, '1 week'],
];

// percent of the limit used. the api always sends two decimals, so dropping the point gives cents
const share = (part: string | undefined, total: string) => {
  const cents = (v: string) => BigInt(v.replace('.', ''));
  const t = cents(total);
  return t === 0n ? 0 : Number((cents(part ?? '0.00') * 100n) / t);
};

function Row({ m }: { m: Mandate }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.revoke(m.id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['mandates'] }),
  });
  const active = m.status === 'MANDATE_STATUS_ACTIVE';
  const spent = share(m.spent?.value, m.maxTotal.value);
  const held = share(m.reserved?.value, m.maxTotal.value);
  return (
    <li className={`border-t border-rule py-4 ${active ? '' : 'text-ink-soft'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-lg font-medium">“{m.task}”</p>
        {active ? (
          <button
            type="button"
            onClick={() => revoke.mutate()}
            disabled={revoke.isPending}
            className="text-sm text-refused hover:underline"
          >
            Revoke
          </button>
        ) : (
          <span className="text-sm">
            {m.status === 'MANDATE_STATUS_REVOKED' ? 'Revoked' : 'Expired'}
          </span>
        )}
      </div>
      <p className="mt-1 text-[15px]">
        {m.tools.map(toolName).join(', ')}, up to {money(m.maxPerCall)} each and {money(m.maxTotal)}{' '}
        in total
        {(m.counterparties ?? []).length > 0
          ? `, only to ${m.counterparties?.join(', ')}`
          : ', to anyone'}
        .
      </p>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-rule" aria-hidden="true">
        <div className="bg-ink" style={{ width: `${spent}%` }} />
        <div className="bg-held" style={{ width: `${held}%` }} />
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {money(m.spent)} spent
        {m.reserved && m.reserved.value !== '0.00' ? `, ${money(m.reserved)} on hold` : ''}
        {active ? `. Ends in ${duration(m.expiresAt)}.` : '.'}
      </p>
    </li>
  );
}

export function Mandates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mandates'], queryFn: api.mandates, refetchInterval: 5000 });
  const [form, setForm] = useState({
    task: '',
    maxPerCall: '',
    maxTotal: '',
    payees: '',
    minutes: 240,
    tools: ['send_payout'],
  });
  const create = useMutation({
    mutationFn: () =>
      api.createMandate({
        agentId: 'ops-agent',
        task: form.task,
        maxPerCall: form.maxPerCall,
        maxTotal: form.maxTotal,
        counterparties: form.payees.split(/[\s,]+/).filter(Boolean),
        tools: form.tools,
        expiresInMinutes: form.minutes,
      }),
    onSuccess: () => {
      setForm((f) => ({ ...f, task: '', payees: '' }));
      qc.invalidateQueries({ queryKey: ['mandates'] });
    },
  });
  const [words, setWords] = useState('');
  const draft = useMutation({
    mutationFn: () => api.draftMandate(words),
    onSuccess: (d) =>
      setForm((f) => ({
        task: d.task,
        tools: d.tools.length > 0 ? d.tools : f.tools,
        maxPerCall: d.maxPerCall ?? '',
        maxTotal: d.maxTotal ?? '',
        payees: d.counterparties.join('\n'),
        // the shortest choice that covers what was asked, or the longest one
        minutes: DURATIONS.find(([v]) => v >= (d.expiresInMinutes ?? f.minutes))?.[0] ?? 10080,
      })),
  });
  // a draft that named payees but kept none would grant "anyone"; make the owner fill them in
  const payeesMissing = draft.data?.namedPayees === true && form.payees.trim() === '';
  const [allPast, setAllPast] = useState(false);
  const active = (q.data ?? []).filter((m) => m.status === 'MANDATE_STATUS_ACTIVE');
  const past = (q.data ?? []).filter((m) => m.status !== 'MANDATE_STATUS_ACTIVE');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const field = 'mt-1 block w-full rounded-sm border border-rule bg-sheet px-3 py-2';

  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">What your agent may do</h2>
        <p className="text-ink-soft">
          A mandate lets the agent pay without asking you, within limits you set. Anything outside
          it comes to you.
        </p>
        <ul className="mt-3">
          {[...active, ...(allPast ? past : past.slice(0, 5))].map((m) => (
            <Row key={m.id} m={m} />
          ))}
        </ul>
        {past.length > 5 && (
          <button
            type="button"
            onClick={() => setAllPast(!allPast)}
            className="mt-2 text-sm text-blue hover:underline"
          >
            {allPast ? 'Show fewer' : `Show all ${past.length} past mandates`}
          </button>
        )}
        {q.data?.length === 0 && (
          <p className="mt-3 text-ink-soft">
            No mandates yet, so every payment will ask you first.
          </p>
        )}
      </div>

      <form onSubmit={submit} className="space-y-4 border-t-2 border-ink pt-6">
        <h2 className="text-lg font-semibold">Give the agent a mandate</h2>
        <div className="space-y-2 rounded-sm border border-rule bg-sheet p-4">
          <label className="block">
            <span className="text-sm font-medium">
              Or describe it, and Warden fills in the form
            </span>
            <textarea
              rows={2}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              className={field}
              placeholder="Pay Arjun (arjun@mehta-dev.example) up to $100 each and $200 in total, until tonight"
            />
          </label>
          <button
            type="button"
            onClick={() => draft.mutate()}
            disabled={draft.isPending || words.trim() === ''}
            className="rounded-sm border border-ink px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {draft.isPending ? 'Reading…' : 'Fill in the form'}
          </button>
          {draft.isSuccess && (
            <div className="text-sm" aria-live="polite">
              <p>Check every field below, then grant it. Nothing is allowed until you do.</p>
              {draft.data.dropped.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-held">
                  {draft.data.dropped.map((d) => (
                    <li key={d}>Left out: {d}.</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {draft.isError && (
            <p role="alert" className="text-sm text-refused">
              {(draft.error as Error).message}
            </p>
          )}
        </div>
        <label className="block">
          <span className="text-sm font-medium">What is it for, in your words</span>
          <input
            required
            value={form.task}
            onChange={(e) => setForm({ ...form, task: e.target.value })}
            className={field}
            placeholder="Pay approved contractor invoices"
          />
        </label>
        <fieldset>
          <legend className="text-sm font-medium">Actions it covers</legend>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
            {TOOLS.map((t) => (
              <label key={t} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.tools.includes(t)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      tools: e.target.checked
                        ? [...form.tools, t]
                        : form.tools.filter((x) => x !== t),
                    })
                  }
                />
                {toolName(t)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-sm font-medium">Most per payment (USD)</span>
            <input
              required
              inputMode="decimal"
              pattern="\d+(\.\d{2})?"
              value={form.maxPerCall}
              onChange={(e) => setForm({ ...form, maxPerCall: e.target.value })}
              className={field}
              placeholder="100.00"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Most in total (USD)</span>
            <input
              required
              inputMode="decimal"
              pattern="\d+(\.\d{2})?"
              value={form.maxTotal}
              onChange={(e) => setForm({ ...form, maxTotal: e.target.value })}
              className={field}
              placeholder="200.00"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Lasts for</span>
            <select
              value={form.minutes}
              onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })}
              className={field}
            >
              {DURATIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium">
            Only these payees (emails or ids, leave empty for anyone)
          </span>
          <textarea
            rows={2}
            value={form.payees}
            onChange={(e) => setForm({ ...form, payees: e.target.value })}
            className={field}
          />
        </label>
        {payeesMissing && (
          <p role="alert" className="text-sm font-medium text-refused">
            You named payees, but Warden found no address for them. Add their emails or payment ids,
            or an empty list would let the agent pay anyone.
          </p>
        )}
        {create.isError && (
          <p role="alert" className="text-sm text-refused">
            {(create.error as Error).message}
          </p>
        )}
        <button
          type="submit"
          disabled={create.isPending || form.tools.length === 0 || payeesMissing}
          className="rounded-sm bg-ink px-4 py-2 font-medium text-sheet disabled:opacity-50"
        >
          Grant mandate
        </button>
      </form>
    </section>
  );
}
