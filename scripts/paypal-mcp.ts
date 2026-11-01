import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// stdio runs paypal's own mcp server package locally. the hosted sandbox server
// answers every tool with PAYPAL_API_SETUP_ERROR right now, so it isn't the default.
export type Transport = 'stdio' | 'sse';

export function transportFromEnv(): Transport {
  const t = process.env.PAYPAL_MCP_TRANSPORT ?? 'stdio';
  if (t !== 'stdio' && t !== 'sse') throw new Error(`unknown PAYPAL_MCP_TRANSPORT: ${t}`);
  return t;
}

export async function connectPayPalMcp(token: string, transport = transportFromEnv()) {
  const client = new Client({ name: 'warden', version: '0.0.0' });
  if (transport === 'stdio') {
    const entry = createRequire(import.meta.url).resolve('@paypal/mcp/dist/index.js');
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry, '--tools=all'],
        // only what the server needs, so nothing else from our env leaks into it
        env: {
          PATH: process.env.PATH ?? '',
          PAYPAL_ACCESS_TOKEN: token,
          PAYPAL_ENVIRONMENT: 'SANDBOX',
        },
        stderr: 'ignore',
      }),
    );
    return { client, source: `stdio:@paypal/mcp` };
  }

  const url = process.env.PAYPAL_MCP_URL ?? 'https://mcp.sandbox.paypal.com/sse';
  if (!url.includes('sandbox')) throw new Error(`refusing non-sandbox mcp url: ${url}`);
  const authorization = `Bearer ${token}`;
  await client.connect(
    new SSEClientTransport(new URL(url), {
      requestInit: { headers: { authorization } },
      eventSourceInit: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization },
          }),
      },
    }),
  );
  return { client, source: url };
}
