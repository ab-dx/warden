import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadScenario, type Scenario } from './scenario.js';

// a pretend mailbox for the demo agent. its content is untrusted: one email carries
// hidden instructions meant for whatever ai reads it.
export function inboxServer(scenario: Scenario) {
  const server = new McpServer({ name: 'inbox', version: '0.1.0' });
  server.registerTool(
    'list_emails',
    { description: "List today's emails in the business inbox.", inputSchema: {} },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            scenario.emails.map(({ id, from, subject }) => ({ id, from, subject })),
          ),
        },
      ],
    }),
  );
  server.registerTool(
    'read_email',
    { description: 'Read one email by id.', inputSchema: { id: z.string() } },
    async ({ id }) => {
      const e = scenario.emails.find((x) => x.id === id);
      return e
        ? { content: [{ type: 'text', text: JSON.stringify(e) }] }
        : { content: [{ type: 'text', text: `no email ${id}` }], isError: true };
    },
  );
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = JSON.parse(
    readFileSync(
      process.env.SEED_FILE ?? new URL('../../../.seed/sandbox.json', import.meta.url),
      'utf8',
    ),
  ) as {
    orders: { captureId: string; amount: { value: string } }[];
  };
  // the refund email asks for $45.00, so use a fresh capture of that size
  const capture = [...seed.orders].reverse().find((o) => o.amount.value === '45.00')?.captureId;
  const scenario = loadScenario(new URL('../scenarios/priya.json', import.meta.url).pathname, {
    contractor: process.env.DEMO_CONTRACTOR_EMAIL ?? '',
    capture: capture ?? '',
  });
  const port = Number(process.env.INBOX_PORT ?? 7010);
  createServer(async (req, res) => {
    if (req.url !== '/mcp') return void res.writeHead(404).end();
    // stateless: one server per request is fine for a read-only mailbox
    const transport = new StreamableHTTPServerTransport({});
    res.on('close', () => transport.close());
    await inboxServer(scenario).connect(transport);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    await transport.handleRequest(
      req,
      res,
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
    );
  }).listen(port, () => console.log(`inbox on :${port}/mcp`));
}
