// can text aimed at the reviewer talk it into a payment? runs every bench payment past
// warden's blind judge and past a reviewer that reads the emails, then again with a hidden
// note to the reviewer in the attacker's email. no stack needed:
// JUDGE_LLM_BASE_URL=... JUDGE_LLM_MODEL=... pnpm --filter @warden/bench reviewer-eval
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Verdict } from '@warden/core';
import { chatCompletions, intentJudge, verdictFrom } from '@warden/judge-service/intent';
import { type Judged, scoreJudge } from './judge-cases.js';
import { READING_SYSTEM, readingPrompt, reviewerCases, withNote } from './reviewer.js';
import { loadScenarios } from './scenario.js';

const env = process.env;
const baseUrl = env.JUDGE_LLM_BASE_URL;
const model = env.JUDGE_LLM_MODEL;
if (!baseUrl || !model) throw new Error('set JUDGE_LLM_BASE_URL and JUDGE_LLM_MODEL');
const minConfidence = Number(env.JUDGE_MIN_CONFIDENCE ?? '0.7');

const complete = chatCompletions({
  baseUrl,
  model,
  apiKey: env.JUDGE_LLM_API_KEY,
  timeoutMs: Number(env.JUDGE_LLM_TIMEOUT_MS ?? '30000'),
});
const blind = intentJudge({ complete, minConfidence, failures: Number.POSITIVE_INFINITY });

async function reading(...args: Parameters<typeof readingPrompt>): Promise<Verdict> {
  try {
    return verdictFrom(await complete(READING_SYSTEM, readingPrompt(...args)), minConfidence);
  } catch (err) {
    const message = `the reviewer could not be reached: ${(err as Error).message}`;
    return { outcome: 'deny', reasons: [{ code: 'CHECK_FAILED', message, check: 'judge' }] };
  }
}

const arms = { blind: [] as Judged[], reads: [] as Judged[], readsInjected: [] as Judged[] };
const cases = reviewerCases(loadScenarios(fileURLToPath(new URL('../scenarios', import.meta.url))));

for (const c of cases) {
  const row = async (arm: Judged[], run: () => Promise<Verdict>) => {
    const t = performance.now();
    const verdict = await run();
    arm.push({
      id: c.id,
      category: c.category,
      want: c.want,
      verdict,
      ms: Math.round(performance.now() - t),
    });
    return verdict.outcome.padEnd(8);
  };
  const b = await row(arms.blind, () => blind(c.intent, c.mandates, c.seen));
  const r = await row(arms.reads, () => reading(c.intent, c.mandates, c.seen, c.emails));
  // the blind judge's input doesn't change with the note, so only the reader is rerun
  const i =
    c.want === 'catch'
      ? await row(arms.readsInjected, () =>
          reading(c.intent, c.mandates, c.seen, withNote(c.emails, c.target)),
        )
      : '-'.padEnd(8);
  console.log(`${c.id.padEnd(18)} want ${c.want.padEnd(6)} blind ${b} reads ${r} reads+note ${i}`);
}

const summary = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, scoreJudge(v)]));
for (const [k, s] of Object.entries(summary))
  console.log(
    `${k.padEnd(14)} caught ${s.attacksCaught}/${s.attacks} attacks, ${s.falsePositives}/${s.benign} false positives, ${s.errors} errors`,
  );

const at = new Date().toISOString();
const dir = fileURLToPath(new URL('../results/reviewer', import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}/${at.replaceAll(':', '-').replace('.', '-')}-${model.replaceAll(/[^\w.-]+/g, '_')}.json`;
writeFileSync(
  file,
  `${JSON.stringify({ at, model, minConfidence, readingSystem: READING_SYSTEM, summary, arms }, null, 2)}\n`,
);
console.log(`wrote ${file}`);
