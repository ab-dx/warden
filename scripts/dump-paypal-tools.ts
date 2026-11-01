// captures the live tool list so tiers and normalisers are built from real
// schemas rather than from docs. one file per transport, since they differ.
import { writeFile } from 'node:fs/promises';
import { connectPayPalMcp, transportFromEnv } from './paypal-mcp.ts';
import { mintToken } from './paypal-token.ts';

const transport = transportFromEnv();
const { token } = await mintToken();
const { client, source } = await connectPayPalMcp(token, transport);

const tools = [];
let cursor: string | undefined;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
await client.close();

tools.sort((a, b) => a.name.localeCompare(b.name));
const file = transport === 'sse' ? 'docs/paypal-tools.json' : 'docs/paypal-tools.stdio.json';
const out = { capturedAt: new Date().toISOString(), source, count: tools.length, tools };
await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${tools.length} tools to ${file}`);
