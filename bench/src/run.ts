import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ARMS, type Arm, env, harness, preflightJudge, root, setArm } from './harness.js';
import { loadScenarios } from './scenario.js';
import { type ScenarioResult, summarise } from './score.js';

const { values: args } = parseArgs({
  options: {
    arms: { type: 'string' },
    only: { type: 'string' },
    runs: { type: 'string', default: '1' },
    driver: { type: 'string', default: 'scripted' },
  },
});
// full adds the llm judge, so without one it would just repeat provenance
const arms = (args.arms?.split(',') ??
  ARMS.filter((a) => a !== 'full' || env.JUDGE_LLM_BASE_URL)) as Arm[];
for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}`);
if (arms.includes('full') && !env.JUDGE_LLM_BASE_URL)
  throw new Error('the full arm needs the llm judge: set JUDGE_LLM_BASE_URL and JUDGE_LLM_MODEL');
const only = args.only?.split(',');
const runs = Number(args.runs);
const driver = args.driver === 'llm' ? 'llm' : 'scripted';
if (driver === 'llm' && (!env.AGENT_BASE_URL || !env.AGENT_MODEL))
  throw new Error('the llm driver needs AGENT_BASE_URL and AGENT_MODEL');

const scenarios = loadScenarios(`${root}scenarios`).filter((s) => !only || only.includes(s.id));

if (arms.includes('full')) await preflightJudge();
const h = await harness();
const out: Record<
  string,
  {
    summary: ReturnType<typeof summarise> & { payoutFailures: number };
    scenarios: ScenarioResult[];
  }
> = {};

try {
  for (const arm of arms) {
    if (arm !== 'baseline') setArm(arm);
    const results: ScenarioResult[] = [];
    let payoutFailures = 0;
    for (let run = 0; run < runs; run++) {
      for (const s of scenarios) {
        const { result: r, payoutsFailed: failed } = await h.run(arm, s, driver);
        results.push(r);
        payoutFailures += failed;
        if (failed)
          console.log(
            `  paypal refused ${failed} payout(s) in ${s.id}; is the sandbox balance empty?`,
          );
        const ok = r.graded.filter((g) => g.correct).length;
        console.log(
          `${arm.padEnd(8)} ${s.id.padEnd(16)} ${ok}/${r.graded.length}${r.extra.length ? ` +${r.extra.length} extra` : ''}`,
        );
      }
    }
    out[arm] = { summary: { ...summarise(results), payoutFailures }, scenarios: results };
  }
} finally {
  // back to the stack as .env configures it
  if (arms.some((a) => a === 'policy' || a === 'provenance')) setArm('full');
  await h.close();
}

const report = {
  at: new Date().toISOString(),
  driver,
  agentModel: driver === 'llm' ? env.AGENT_MODEL : 'scripted',
  judgeModel: arms.includes('full') ? env.JUDGE_LLM_MODEL || null : null,
  runs,
  arms: out,
};
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${v}%`);
const rows = [
  ['', ...arms],
  ['attack calls that reached paypal', ...arms.map((a) => fmt(out[a]?.summary.attackSuccess))],
  [
    'attack scenarios with any harm done',
    ...arms.map((a) => {
      const x = out[a]?.summary;
      return x ? `${x.attackScenariosBreached} of ${x.attackScenarios}` : '-';
    }),
  ],
  ['benign calls allowed', ...arms.map((a) => fmt(out[a]?.summary.benignAllowed))],
  ['benign calls held for approval', ...arms.map((a) => fmt(out[a]?.summary.benignHeldCorrectly))],
  ['false positives', ...arms.map((a) => String(out[a]?.summary.falsePositives ?? '-'))],
  ['payouts paypal refused', ...arms.map((a) => String(out[a]?.summary.payoutFailures ?? '-'))],
  ['median time to allow (ms)', ...arms.map((a) => String(out[a]?.summary.medianAllowMs ?? '-'))],
];
const table = rows
  .map((r, i) => `| ${r.join(' | ')} |${i === 0 ? `\n|${r.map(() => ' --- ').join('|')}|` : ''}`)
  .join('\n');
mkdirSync(`${root}results`, { recursive: true });
const stamp = report.at.replace(/[:.]/g, '-');
writeFileSync(`${root}results/${stamp}-${driver}.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${table}\n`);
process.exit(0);
