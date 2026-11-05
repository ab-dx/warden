// runs the intent judge alone against every bench payment, no stack needed:
// JUDGE_LLM_BASE_URL=... JUDGE_LLM_MODEL=... pnpm --filter @warden/bench judge-eval
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chatCompletions, intentJudge, SYSTEM } from '@warden/judge-service/intent';
import { type Judged, judgeCases, scoreJudge } from './judge-cases.js';
import { loadScenarios } from './scenario.js';

const env = process.env;
const baseUrl = env.JUDGE_LLM_BASE_URL;
const model = env.JUDGE_LLM_MODEL;
if (!baseUrl || !model) throw new Error('set JUDGE_LLM_BASE_URL and JUDGE_LLM_MODEL');
const minConfidence = Number(env.JUDGE_MIN_CONFIDENCE ?? '0.7');

const judge = intentJudge({
  complete: chatCompletions({
    baseUrl,
    model,
    apiKey: env.JUDGE_LLM_API_KEY,
    timeoutMs: Number(env.JUDGE_LLM_TIMEOUT_MS ?? '30000'),
  }),
  minConfidence,
  // every case should reach the model; an open breaker would hide failures as fast denies
  failures: Number.POSITIVE_INFINITY,
});

const cases = judgeCases(loadScenarios(fileURLToPath(new URL('../scenarios', import.meta.url))));
const rows: Judged[] = [];
for (const c of cases) {
  const t = performance.now();
  const verdict = await judge(c.intent, c.mandates, c.seen);
  const ms = Math.round(performance.now() - t);
  rows.push({ id: c.id, category: c.category, want: c.want, verdict, ms });
  const right =
    c.want === 'either' ? ' ' : (verdict.outcome === 'allow') === (c.want === 'allow') ? '✓' : '✗';
  console.log(
    `${right} ${c.id.padEnd(18)} want ${c.want.padEnd(6)} got ${verdict.outcome.padEnd(8)} ${String(ms).padStart(6)} ms  ${verdict.reasons[0]?.message ?? ''}`,
  );
}

const summary = scoreJudge(rows);
console.log(
  `\n${model}: caught ${summary.attacksCaught}/${summary.attacks} attacks, ` +
    `${summary.falsePositives}/${summary.benign} false positives, ${summary.errors} errors, ` +
    `median ${summary.medianMs} ms`,
);

const at = new Date().toISOString();
const dir = fileURLToPath(new URL('../results/judge', import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}/${at.replaceAll(':', '-').replace('.', '-')}-${model.replaceAll(/[^\w.-]+/g, '_')}.json`;
writeFileSync(
  file,
  `${JSON.stringify({ at, model, minConfidence, system: SYSTEM, summary, rows }, null, 2)}\n`,
);
console.log(`wrote ${file}`);
