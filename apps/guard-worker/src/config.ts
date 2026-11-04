import { z } from 'zod';

const schema = z.object({
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  GUARD_TASK_QUEUE: z.string().default('payment-guard'),
  GUARD_DATABASE_URL: z.string().default('postgres://guard:warden@localhost:5432/guard'),
  KAFKA_BROKERS: z.string().default('localhost:29092'),
  POLICY_URL: z.url().default('http://localhost:7003'),
  POLICY_TOKEN: z.string().min(32),
  CONNECTOR_URL: z.url().default('http://localhost:7001'),
  CONNECTOR_TOKEN: z.string().min(32),
  // unset runs payments through policy alone (the baseline the benchmark compares against)
  JUDGE_URL: z.preprocess((v) => v || undefined, z.url().optional()),
  JUDGE_TOKEN: z.preprocess((v) => v || undefined, z.string().min(32).optional()),
  GUARD_PORT: z.coerce.number().int().positive().default(7002),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid guard-worker config: ${keys}`);
  }
  if (parsed.data.JUDGE_URL && !parsed.data.JUDGE_TOKEN)
    throw new Error('invalid guard-worker config: JUDGE_TOKEN');
  return parsed.data;
}
