import { readFile } from 'node:fs/promises';
import { toMinor } from '@warden/core';
import { parse } from 'yaml';
import { z } from 'zod';

const tier = z.enum(['T0', 'T1', 'T2', 'T3']);
const money = z.object({ value: z.string(), currency: z.string() }).transform((m, ctx) => {
  try {
    return { minor: toMinor(m), currency: m.currency };
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
    return z.NEVER;
  }
});
// patterns are pasted into cedar policy text, so only allow characters that can't break out of a string
const pattern = z
  .string()
  .regex(/^[A-Za-z0-9@._+*-]+$/, 'pattern may only use letters, digits, @ . _ + - *');

const agentPolicy = z
  .object({
    require_mandate_for: z.array(tier).default(['T2', 'T3']),
    max_per_call: money,
    daily_budget: money,
    velocity: z.object({
      max_calls: z.number().int().positive(),
      per_seconds: z.number().int().positive(),
      tiers: z.array(tier),
    }),
    duplicate_window_seconds: z.number().int().nonnegative(),
    deny_counterparties: z.array(pattern).default([]),
    // reason codes that send a call to a human; every other reason denies
    escalate_when: z.array(z.string()).default([]),
  })
  .refine(
    (p) => p.max_per_call.currency === p.daily_budget.currency,
    'limits must share a currency',
  );

export const policyFileSchema = z.object({ agents: z.record(z.string(), agentPolicy) });

export type AgentPolicy = z.infer<typeof agentPolicy>;
export type PolicyFile = z.infer<typeof policyFileSchema>;

export function parsePolicyFile(text: string): PolicyFile {
  const parsed = policyFileSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new Error(
      `invalid policy file: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

export async function loadPolicyFile(path: string): Promise<PolicyFile> {
  return parsePolicyFile(await readFile(path, 'utf8'));
}
