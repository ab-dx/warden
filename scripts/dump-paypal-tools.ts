// captures the live sandbox tool list so tiers and normalisers are built from
// real schemas rather than from docs
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mintToken } from './paypal-token.ts';

const url = process.env.PAYPAL_MCP_URL ?? 'https://mcp.sandbox.paypal.com/http';
if (!url.includes('sandbox')) throw new Error(`refusing non-sandbox mcp url: ${url}`);

const { token } = await mintToken();
const client = new Client({ name: 'warden-tools-dump', version: '0.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);

const tools = [];
let cursor: string | undefined;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
await client.close();

tools.sort((a, b) => a.name.localeCompare(b.name));
const out = { capturedAt: new Date().toISOString(), source: url, count: tools.length, tools };
await writeFile('docs/paypal-tools.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${tools.length} tools to docs/paypal-tools.json`);
