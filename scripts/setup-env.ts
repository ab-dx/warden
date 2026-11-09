// fills in the secrets the services share with each other, without touching any value
// already in .env. paypal credentials still come from you.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = '.env';
if (!existsSync(file))
  throw new Error('copy .env.example to .env and add your paypal sandbox credentials first');
const current = readFileSync(file, 'utf8');
const has = (k: string) => new RegExp(`^${k}=.+`, 'm').test(current);
const hex = (n: number) => randomBytes(n).toString('hex');

const agentKey = /^WARDEN_AGENT_KEY=(.+)$/m.exec(current)?.[1] ?? hex(24);
const benchKey = /^BENCH_AGENT_KEY=(.+)$/m.exec(current)?.[1] ?? hex(24);
const labKey = /^LAB_AGENT_KEY=(.+)$/m.exec(current)?.[1] ?? hex(24);
const wanted: Record<string, string> = {
  POLICY_TOKEN: hex(32),
  CONNECTOR_TOKEN: hex(32),
  LEDGER_TOKEN: hex(32),
  JUDGE_TOKEN: hex(32),
  SESSION_SECRET: hex(32),
  // ed25519 seed for signing mandates as tokens
  MANDATE_SIGNING_KEY: randomBytes(32).toString('base64url'),
  DASHBOARD_PASSWORD: hex(9),
  WARDEN_AGENT_KEY: agentKey,
  BENCH_AGENT_KEY: benchKey,
  LAB_AGENT_KEY: labKey,
  WARDEN_AGENT_KEYS: `ops-agent:${agentKey},bench-agent:${benchKey},lab-agent:${labKey}`,
};

// fill empty KEY= lines (as copied from .env.example) in place, append missing keys,
// and never change a value that is already set
let next = current;
const filled: string[] = [];
const appended: string[] = [];
for (const [k, v] of Object.entries(wanted)) {
  if (has(k)) continue;
  const empty = new RegExp(`^${k}=$`, 'm');
  if (empty.test(next)) {
    next = next.replace(empty, `${k}=${v}`);
    filled.push(k);
  } else {
    next += `${next.endsWith('\n') ? '' : '\n'}${k}=${v}\n`;
    appended.push(k);
  }
}
// an .env from before the benchmark or the lab existed lacks their agents' keys
for (const [id, key] of [
  ['bench-agent', benchKey],
  ['lab-agent', labKey],
]) {
  const keys = /^WARDEN_AGENT_KEYS=(.+)$/m.exec(next)?.[1];
  if (keys && !keys.split(',').some((k) => k.startsWith(`${id}:`))) {
    next = next.replace(/^WARDEN_AGENT_KEYS=.+$/m, `WARDEN_AGENT_KEYS=${keys},${id}:${key}`);
    filled.push('WARDEN_AGENT_KEYS');
  }
}
const done = [...filled, ...appended];
if (done.length) writeFileSync(file, next);
console.log(done.length ? `set ${done.join(', ')}` : 'nothing to set');
if (done.includes('DASHBOARD_PASSWORD'))
  console.log('the dashboard password is DASHBOARD_PASSWORD in .env');
