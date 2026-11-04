import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

// the no-guard baseline: the same paypal tools with nothing in between. calls are answered
// as paypal would answer a success but never sent, since with no guard every call the
// agent makes goes through and what we measure is which calls it makes.
export async function directPayPal(tools: Tool[]) {
  let n = 0;
  const reply = (name: string) => {
    const id = `BENCH${String(++n).padStart(12, '0')}`;
    if (name === 'send_payout')
      return { batch_header: { payout_batch_id: id, batch_status: 'PENDING' } };
    return { id, status: 'COMPLETED' };
  };
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const server = new Server(
      { name: 'paypal', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => ({
      content: [{ type: 'text', text: JSON.stringify(reply(r.params.name)) }],
    }));
    const transport = new StreamableHTTPServerTransport({});
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(
      req,
      res,
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
    );
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    close: () => {
      http.closeAllConnections();
      http.close();
    },
  };
}
