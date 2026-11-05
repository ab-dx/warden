import { money } from './format.js';

// the committed bench runs, bundled at build time; no api involved
const files = import.meta.glob<Results>('../../../bench/results/*.json', {
  eager: true,
  import: 'default',
});

type Summary = {
  scenarios: number;
  attackScenarios: number;
  attackScenariosBreached: number;
  attackSuccess: number;
  benignAllowed: number;
  benignHeldCorrectly: number;
  payoutFailures?: number;
  byCategory: Record<string, { correct: number; total: number }>;
};
type Graded = {
  tool: string;
  to?: string;
  amount?: string;
  want: 'allow' | 'escalate' | 'block';
  attack: boolean;
  got?: { passed: boolean; first?: string };
  correct: boolean;
};
type Arm = { summary: Summary; scenarios: { id: string; graded: Graded[] }[] };
export type Results = {
  at: string;
  driver: string;
  agentModel: string;
  judgeModel: string | null;
  runs: number;
  arms: Record<'baseline' | 'policy' | 'full', Arm>;
};

export const latest = (all: Results[]) =>
  all.reduce<Results | undefined>((a, r) => (!a || r.at > a.at ? r : a), undefined);

// calls full warden got wrong, attacks that reached paypal first
export function misses(arm: Arm) {
  return arm.scenarios
    .flatMap((s) => s.graded.map((g, j) => ({ id: s.id, key: `${s.id}/${j}`, ...g })))
    .filter((g) => !g.correct)
    .sort((a, b) => Number(b.attack) - Number(a.attack));
}

const ARMS = [
  ['baseline', 'No guard'],
  ['policy', 'Policy only'],
  ['full', 'Full Warden'],
] as const;

const ROWS: [string, (s: Summary) => string][] = [
  [
    'Attack scenarios where money reached the attacker',
    (s) => `${s.attackScenariosBreached} of ${s.attackScenarios}`,
  ],
  ['Attack payments that reached PayPal', (s) => `${s.attackSuccess}%`],
  ['Legitimate payments allowed straight through', (s) => `${s.benignAllowed}%`],
  ['Legitimate payments held for approval when they should be', (s) => `${s.benignHeldCorrectly}%`],
];

const CATEGORY: Record<string, string> = {
  benign: 'Benign',
  approval: 'Benign, outside the mandate',
  redirection: 'Payee redirection',
  inflation: 'Inflated amount',
  unrequested: 'Unrequested action',
  split: 'Split or repeated payments',
  in_mandate: 'Attack inside the mandate',
};

export function Bench() {
  const r = latest(Object.values(files));
  if (!r)
    return (
      <p className="text-ink-soft">
        No benchmark results yet. Run <code>pnpm --filter @warden/bench bench</code> and rebuild.
      </p>
    );
  const full = r.arms.full;
  const wrong = misses(full);
  const refused = ARMS.reduce((n, [k]) => n + (r.arms[k].summary.payoutFailures ?? 0), 0);

  return (
    <div className="space-y-12">
      <section aria-labelledby="bench-h" className="space-y-3">
        <h2 id="bench-h" className="text-lg font-semibold">
          How Warden did against {full.summary.scenarios} scenarios
        </h2>
        <p className="text-ink-soft">
          Run {new Date(r.at).toLocaleString()} · agent {r.agentModel} · intent judge{' '}
          {r.judgeModel ?? 'off'} · {r.runs} {r.runs === 1 ? 'run' : 'runs'}
        </p>
        {refused > 0 && (
          <p className="text-held">
            PayPal refused {refused} payouts in this run, so some numbers may be skewed.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[15px]">
            <thead className="text-sm text-ink-soft">
              <tr className="border-b border-rule">
                <th className="py-2 pr-4 font-normal" />
                {ARMS.map(([k, label]) => (
                  <th key={k} className="py-2 pr-4 text-right font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([label, cell]) => (
                <tr key={label} className="border-b border-rule/70">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {label}
                  </th>
                  {ARMS.map(([k]) => (
                    <td
                      key={k}
                      className={`whitespace-nowrap py-2 pr-4 text-right ${k === 'full' ? 'font-semibold' : ''}`}
                    >
                      {cell(r.arms[k].summary)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="cat-h" className="space-y-3">
        <h2 id="cat-h" className="text-lg font-semibold">
          Payments decided correctly, by kind
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[15px]">
            <thead className="text-sm text-ink-soft">
              <tr className="border-b border-rule">
                <th className="py-2 pr-4 font-normal">Kind</th>
                {ARMS.map(([k, label]) => (
                  <th key={k} className="py-2 pr-4 text-right font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.keys(full.summary.byCategory).map((c) => (
                <tr key={c} className="border-b border-rule/70">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {CATEGORY[c] ?? c}
                  </th>
                  {ARMS.map(([k]) => {
                    const v = r.arms[k].summary.byCategory[c];
                    return (
                      <td key={k} className="whitespace-nowrap py-2 pr-4 text-right">
                        {v ? `${v.correct} of ${v.total}` : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="miss-h" className="space-y-3">
        <h2 id="miss-h" className="text-lg font-semibold">
          What full Warden got wrong
        </h2>
        {wrong.length === 0 ? (
          <p className="text-ink-soft">
            Nothing. Every payment was decided as the scenario expected.
          </p>
        ) : (
          <ul className="space-y-2">
            {wrong.map((g) => (
              <li key={g.key} className="border-b border-rule/70 pb-2">
                <span className={g.attack ? 'font-medium text-refused' : 'font-medium text-held'}>
                  {g.attack
                    ? g.got?.passed
                      ? 'Attack reached PayPal'
                      : 'Attack not decided as expected'
                    : 'Legitimate payment held'}
                </span>{' '}
                <span className="text-ink-soft">
                  {g.id} · {g.tool} {g.to ?? ''}{' '}
                  {g.amount ? money({ value: g.amount, currency: 'USD' }) : ''} · expected {g.want},
                  got {g.got?.first ?? 'no call'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
