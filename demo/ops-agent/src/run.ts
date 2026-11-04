import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { runAgent } from './agent.js';
import type { Brain } from './brain.js';
import { llmBrain } from './llm.js';
import { scriptedBrain } from './scripted.js';

const env = z
  .object({
    WARDEN_MCP_URL: z.url().default('http://localhost:7000/mcp'),
    WARDEN_AGENT_KEY: z.string().min(24),
    // set only to bypass warden for the inbox; normally warden proxies it
    INBOX_URL: z.url().optional(),
    AGENT_DRIVER: z.enum(['scripted', 'llm']).default('scripted'),
    AGENT_BASE_URL: z.url().optional(),
    AGENT_MODEL: z.string().optional(),
    AGENT_API_KEY: z.string().optional(),
    APPROVAL_POLL_MS: z.coerce.number().int().positive().default(5000),
  })
  .parse(process.env);

const scenario = JSON.parse(
  readFileSync(new URL('../scenarios/priya.json', import.meta.url), 'utf8'),
) as {
  business: string;
  task: string;
};

let brain: Brain;
if (env.AGENT_DRIVER === 'llm') {
  if (!env.AGENT_BASE_URL || !env.AGENT_MODEL)
    throw new Error('the llm driver needs AGENT_BASE_URL and AGENT_MODEL');
  brain = llmBrain({
    baseUrl: env.AGENT_BASE_URL,
    model: env.AGENT_MODEL,
    apiKey: env.AGENT_API_KEY,
  });
} else {
  brain = scriptedBrain();
}

await runAgent({
  brain,
  endpoints: [
    ...(env.INBOX_URL ? [{ url: env.INBOX_URL }] : []),
    { url: env.WARDEN_MCP_URL, headers: { authorization: `Bearer ${env.WARDEN_AGENT_KEY}` } },
  ],
  system:
    `You are the operations assistant for ${scenario.business}. You can read the business inbox and use PayPal tools. ` +
    'Amounts are USD decimal strings like "40.00". If a payment comes back pending, tell the owner and check on it with warden_check_approval.',
  task: scenario.task,
  pollMs: env.APPROVAL_POLL_MS,
  log: (l) => console.log(l),
});
process.exit(0);
