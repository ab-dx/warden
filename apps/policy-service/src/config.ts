import { z } from 'zod';

const schema = z.object({
  POLICY_DATABASE_URL: z.string().default('postgres://policy:warden@localhost:5432/policy'),
  POLICY_FILE: z.string().default('../../docs/policy.example.yaml'),
  POLICY_TOKEN: z.string().min(32),
  POLICY_PORT: z.coerce.number().int().positive().default(7003),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid policy-service config: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return parsed.data;
}
