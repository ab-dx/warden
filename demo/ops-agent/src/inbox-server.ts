import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { labEmail, runLab } from './lab.js';
import { loadScenario, type Scenario } from './scenario.js';

// a pretend mailbox for the demo agent. its content is untrusted: one email carries
// hidden instructions meant for whatever ai reads it.
const email = z.object({
  id: z.string().min(1),
  from: z.string(),
  subject: z.string(),
  body: z.string(),
});

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
  let mailbox = scenario;
  // one lab run at a time: a run owns the mailbox until it's done
  let lab = Promise.resolve();
  const wardenUrl = process.env.LAB_WARDEN_URL;
  const labKey = process.env.LAB_AGENT_KEY;
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

    // the benchmark swaps in each scenario's emails, then puts the demo's back
    if (req.url === '/mailbox' && req.method === 'PUT') {
      const emails = z.array(email).safeParse(body?.emails);
      if (!emails.success) return void res.writeHead(400).end();
      mailbox = { ...scenario, emails: emails.data };
      return void res.writeHead(204).end();
    }
    if (req.url === '/mailbox' && req.method === 'DELETE') {
      mailbox = scenario;
      return void res.writeHead(204).end();
    }
    // the attack lab: the api calls this for a signed-in owner, never the public
    if (req.url === '/lab/run' && req.method === 'POST') {
      const email = labEmail.safeParse(body?.email);
      const guarded = body?.guarded !== false;
      if (!email.success) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: email.error.issues[0]?.message }));
      }
      if (guarded && (!wardenUrl || !labKey)) return void res.writeHead(503).end();
      const run = lab.then(async () => {
        const before = mailbox;
        mailbox = { ...scenario, emails: [{ id: 'lab-1', ...email.data }] };
        try {
          return await runLab({
            guarded,
            inboxUrl: `http://127.0.0.1:${port}/mcp`,
            warden: wardenUrl
              ? { url: wardenUrl, headers: { authorization: `Bearer ${labKey}` } }
              : undefined,
          });
        } finally {
          mailbox = before;
        }
      });
      lab = run.then(
        () => {},
        () => {},
      );
      try {
        const steps = await run;
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ steps }));
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: (err as Error).message.slice(0, 200) }));
      }
    }
    if (req.url !== '/mcp') return void res.writeHead(404).end();
    // stateless: one server per request is fine for a read-only mailbox
    const transport = new StreamableHTTPServerTransport({});
    res.on('close', () => transport.close());
    await inboxServer(mailbox).connect(transport);
    await transport.handleRequest(req, res, body);
  }).listen(port, () => console.log(`inbox on :${port}/mcp`));
}
