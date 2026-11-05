import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from './agent.js';
import type { Brain, Message, ToolCall } from './brain.js';

let http: HttpServer | undefined;
afterEach(() => http?.close());

// a refund paypal refuses, and an approval that stays pending twice before it's denied
async function tools() {
  let checks = 0;
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s = new McpServer({ name: 'fake', version: '0' });
    s.registerTool('create_refund', { inputSchema: { capture_id: z.string() } }, async () => ({
      isError: true,
      content: [
        { type: 'text', text: '{"name":"UNPROCESSABLE_ENTITY","details":"already refunded"}' },
      ],
    }));
    s.registerTool('warden_check_approval', { inputSchema: { callId: z.string() } }, async () => {
      const w =
        ++checks < 3
          ? { outcome: 'pending', code: 'PENDING_APPROVAL' }
          : { outcome: 'deny', code: 'TIMEOUT' };
      return {
        content: [{ type: 'text', text: JSON.stringify({ warden: { ...w, message: 'm' } }) }],
      };
    });
    const t = new StreamableHTTPServerTransport({});
    res.on('close', () => t.close());
    await s.connect(t);
    await t.handleRequest(
      req,
      res,
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
    );
  });
  await new Promise<void>((r) => http?.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}

const plan = (turns: ToolCall[][]): Brain => {
  let i = 0;
  return { next: async () => ({ calls: turns[i++] ?? [] }) };
};
const check = (n: number): ToolCall => ({
  id: `k${n}`,
  name: 'warden_check_approval',
  args: { callId: 'c_1' },
});

describe('runAgent', () => {
  it('tells the model and the log when paypal refused a call', async () => {
    const log: string[] = [];
    const messages = await runAgent({
      brain: plan([[{ id: 'r1', name: 'create_refund', args: { capture_id: 'X' } }]]),
      endpoints: [{ url: await tools() }],
      system: 's',
      task: 't',
      log: (l) => log.push(l),
    });
    const reply = messages.find((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool');
    expect(reply?.content).toMatch(/^error: /);
    expect(log.some((l) => l.includes('failed:') && l.includes('already refunded'))).toBe(true);
  });

  it('logs a waiting payment once until its answer changes', async () => {
    const log: string[] = [];
    await runAgent({
      brain: plan([[check(1)], [check(2)], [check(3)]]),
      endpoints: [{ url: await tools() }],
      system: 's',
      task: 't',
      pollMs: 1,
      log: (l) => log.push(l),
    });
    const lines = log.filter((l) => l.includes('warden_check_approval'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('TIMEOUT');
  });
});
