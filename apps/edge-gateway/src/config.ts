import { z } from 'zod';

const schema = z.object({
  GATEWAY_PORT: z.coerce.number().int().positive().default(7000),
  GATEWAY_DATABASE_URL: z.string().default('postgres://gateway:warden@localhost:5432/gateway'),
  KAFKA_BROKERS: z.string().default('localhost:29092'),
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  GUARD_TASK_QUEUE: z.string().default('payment-guard'),
  CONNECTOR_URL: z.url().default('http://localhost:7001'),
  CONNECTOR_TOKEN: z.string().min(32),
  WARDEN_AGENT_KEYS: z.string().min(1),
  // under the 60 s most mcp clients give a tool call before they give up
  GATEWAY_HOLD_MS: z.coerce.number().int().positive().default(45_000),
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  DASHBOARD_URL: z.url().default('http://localhost:5173'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid edge-gateway config: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return parsed.data;
}
