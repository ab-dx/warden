import { money, toolName } from './format.js';

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
  medianAllowMs?: number | null;
  // older runs don't have these
  attackDollarsMoved?: string;
  attackDollarsTried?: string;
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
export type Arm = { summary: Summary; scenarios: { id: string; graded: Graded[] }[] };
export type Results = {
  at: string;
  driver: string;
  agentModel: string;
  judgeModel: string | null;
  runs: number;
  arms: Partial<Record<(typeof ARMS)[number][0], Arm>>;
};

const size = (r: Results) =>
  Math.max(0, ...Object.values(r.arms ?? {}).map((a) => a?.summary.scenarios ?? 0));

// the newest run of the whole suite: a quick run of a few scenarios doesn't replace it
export const latest = (all: Results[]) =>
  all.reduce<Results | undefined>(
    (a, r) => (!a || size(r) > size(a) || (size(r) === size(a) && r.at > a.at) ? r : a),
    undefined,
  );

const usd = (value: string) => ({ value, currency: 'USD' });
const pct = (n: number | null | undefined) => (n == null ? '–' : `${n}%`);

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
  ['provenance', 'Policy + provenance'],
  ['full', 'Full Warden'],
] as const;

const ROWS: [string, (s: Summary) => string][] = [
  [
    'Attack scenarios where money reached the attacker',
    (s) => `${s.attackScenariosBreached} of ${s.attackScenarios}`,
  ],
  ['Attack payments that reached PayPal', (s) => pct(s.attackSuccess)],
  [
    'Attack dollars that reached PayPal',
    (s) =>
      s.attackDollarsMoved
        ? `${money(usd(s.attackDollarsMoved))} of ${money(usd(s.attackDollarsTried ?? '0.00'))}`
        : '–',
  ],
  ['Legitimate payments allowed straight through', (s) => pct(s.benignAllowed)],
  ['Legitimate payments held for approval when they should be', (s) => pct(s.benignHeldCorrectly)],
  [
    'Median time to allow a payment',
    (s) => (s.medianAllowMs == null ? '' : `${(s.medianAllowMs / 1000).toFixed(1)} s`),
  ],
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
  // older runs have three arms, newer ones four; the last one present is the strongest
  const shown = ARMS.flatMap(([k, label]) => {
    const arm = r.arms[k];
    // runs from before the provenance arm saved it as full, with the judge off
    const name = k === 'full' && !r.judgeModel ? 'Policy + provenance' : label;
    return arm ? [{ k, label: name, arm }] : [];
  });
  const top = shown.at(-1);
  if (!top) return null;
  const wrong = misses(top.arm);
  const refused = shown.reduce((n, x) => n + (x.arm.summary.payoutFailures ?? 0), 0);

  return (
    <div className="space-y-12">
      <section aria-labelledby="bench-h" className="space-y-3">
        <h2 id="bench-h" className="wide text-2xl font-bold">
          Benchmark
        </h2>
        <p className="text-ink-soft">
          {top.arm.summary.scenarios} scenarios against PayPal's sandbox, run{' '}
          {new Date(r.at).toLocaleDateString()}. Agent: {r.agentModel}. Intent judge:{' '}
          {r.judgeModel ?? 'off'}. {r.runs} {r.runs === 1 ? 'run' : 'runs'} per scenario.
        </p>
        {refused > 0 && (
          <p className="text-held">
            PayPal declined {refused} payouts in this run, which skews the numbers.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[15px]">
            <thead className="text-sm text-ink-soft">
              <tr className="border-b border-rule">
                <th className="py-2 pr-4 font-normal" />
                {shown.map(({ k, label }) => (
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
                  {shown.map(({ k, arm }) => (
                    <td
                      key={k}
                      className={`whitespace-nowrap py-2 pr-4 text-right ${k === top.k ? 'font-semibold' : ''}`}
                    >
                      {cell(arm.summary)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="cat-h" className="space-y-3">
        <h2 id="cat-h" className="semiwide text-lg font-bold">
          Correct decisions by kind
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[15px]">
            <thead className="text-sm text-ink-soft">
              <tr className="border-b border-rule">
                <th className="py-2 pr-4 font-normal">Kind</th>
                {shown.map(({ k, label }) => (
                  <th key={k} className="py-2 pr-4 text-right font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.keys(top.arm.summary.byCategory).map((c) => (
                <tr key={c} className="border-b border-rule/70">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {CATEGORY[c] ?? c}
                  </th>
                  {shown.map(({ k, arm }) => {
                    const v = arm.summary.byCategory[c];
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
        <h2 id="miss-h" className="semiwide text-lg font-bold">
          Misses with {top.label}
        </h2>
        {wrong.length === 0 ? (
          <p className="text-ink-soft">None. Every payment was decided as the scenario expected.</p>
        ) : (
          <ul className="space-y-2">
            {wrong.map((g) => (
              <li key={g.key} className="border-b border-rule/70 pb-2">
                <span className={g.attack ? 'font-medium text-refused' : 'font-medium text-held'}>
                  {g.attack
                    ? g.got?.passed
                      ? 'Attack paid'
                      : 'Attack, wrong decision'
                    : 'Legitimate payment held'}
                </span>{' '}
                <span className="text-ink-soft">
                  {g.id}: {toolName(g.tool)} of{' '}
                  {g.amount ? money({ value: g.amount, currency: 'USD' }) : 'no amount'} to{' '}
                  {g.to ?? 'no payee'}, expected {g.want}, got {g.got?.first ?? 'no call'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
