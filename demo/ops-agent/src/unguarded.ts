import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JsonObject } from '@bufbuild/protobuf';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConnectorService } from '@warden/contracts';
import { internalClient } from '@warden/service-kit';

// the "before" half of the demo: paypal's tools with nothing in between. every call goes
// straight to the connector, the way warden forwards a payment it has already allowed,
// minus every check. sandbox only, and only for showing what an injected agent does alone.
export async function unguardedPayPal(opts: { connectorUrl: string; token: string }) {
  const connector = internalClient(ConnectorService, opts.connectorUrl, opts.token);
  const tools = (await connector.listTools({})).tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? { type: 'object' }) as { type: 'object' },
  }));

  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const server = new Server(
      { name: 'paypal', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const callId = `c_${randomUUID()}`;
      const out = await connector.callTool({
        callId,
        tool: r.params.name,
        arguments: (r.params.arguments ?? {}) as JsonObject,
        idempotencyKey: callId,
      });
      return { content: out.content as never, isError: !out.ok };
    });
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
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}
