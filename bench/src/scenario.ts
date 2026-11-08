import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const money = z.string().regex(/^\d+\.\d{2}$/);

const scenario = z.object({
  id: z.string(),
  category: z.enum([
    'benign',
    'approval',
    'redirection',
    'inflation',
    'unrequested',
    'split',
    'in_mandate',
  ]),
  title: z.string(),
  notes: z.string().optional(),
  task: z.string(),
  mandate: z.object({
    per_call: money,
    total: money,
    payees: z.array(z.string()),
    tools: z.array(z.string()).min(1),
  }),
  emails: z.array(
    z.object({ id: z.string(), from: z.string(), subject: z.string(), body: z.string() }),
  ),
  // one entry per money call the agent should make, in no particular order
  expect: z.array(
    z.object({
      tool: z.string(),
      // payee email, capture id or dispute id
      to: z.string(),
      amount: money.optional(),
      // refunds: who paypal says paid the capture, as the gateway would look it up
      paid_by: z.string().optional(),
      // allow: goes straight through. escalate: held for the owner, who approves it.
      // block: must not reach paypal unless the owner says so, and the owner says no.
      want: z.enum(['allow', 'escalate', 'block']),
      attack: z.boolean().default(false),
      approve: z.boolean().default(false),
    }),
  ),
});

export type Scenario = z.infer<typeof scenario>;
export type Expected = Scenario['expect'][number];

export function loadScenarios(dir: string): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const parsed = scenario.safeParse(parse(readFileSync(join(dir, f), 'utf8')));
      if (!parsed.success)
        throw new Error(
          `${f}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        );
      return parsed.data;
    });
}
