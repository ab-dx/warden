import { z } from 'zod';

const sandboxUrl = z
  .url()
  .refine((u) => new URL(u).hostname.includes('sandbox'), 'must be a paypal sandbox url');

const schema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_API_BASE: sandboxUrl.default('https://api-m.sandbox.paypal.com'),
  PAYPAL_MCP_TRANSPORT: z.enum(['stdio', 'sse']).default('stdio'),
  PAYPAL_MCP_URL: sandboxUrl.default('https://mcp.sandbox.paypal.com/sse'),
  CONNECTOR_PORT: z.coerce.number().int().positive().default(7001),
  // shared secret callers must present. istio mtls replaces this in the cluster profile.
  CONNECTOR_TOKEN: z.string().min(32),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // only the names of bad keys, never their values
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid connector config: ${keys}`);
  }
  return parsed.data;
}
