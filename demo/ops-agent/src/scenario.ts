import { readFileSync } from 'node:fs';

export type Email = { id: string; from: string; subject: string; body: string };
export type Scenario = { owner: string; business: string; task: string; emails: Email[] };

// fills {{contractor}} and {{capture}} with real sandbox values so the payments are live
export function loadScenario(path: string, vars: Record<string, string>): Scenario {
  const raw = readFileSync(path, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (!v) throw new Error(`scenario needs ${k}`);
    return v;
  });
  return JSON.parse(raw) as Scenario;
}
