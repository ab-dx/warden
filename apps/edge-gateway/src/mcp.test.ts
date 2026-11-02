import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { GuardInput } from '@warden/contracts';
import { describe, expect, it } from 'vitest';
import type { Guard } from './guard.js';
import { type GatewayDeps, gatewayServer } from './mcp.js';

function setup(opts: { auditFails?: boolean } = {}) {
  const forwarded: string[] = [];
  const guarded: GuardInput[] = [];
  const connector = {
    listTools: async () => ({ tools: [] }),
    callTool: async (req: { tool: string }) => {
      forwarded.push(req.tool);
      if (req.tool === 'get_capture') {
        return {
          ok: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ amount: { value: '89.00', currency_code: 'USD' } }),
            },
          ],
        };
      }
      return { ok: true, content: [{ type: 'text', text: '{"id":"X"}' }] };
    },
  };
  const guard = {
    run: async (input: GuardInput) => {
      guarded.push(input);
      return {
        done: {
          outcome: 'deny',
          decidedBy: 'policy',
          reasons: [{ code: 'OVER_DAILY_BUDGET', message: 'too much', check: 'policy' }],
        },
      };
    },
    check: async (_id: string, agentId: string) =>
      agentId === 'ops-agent' ? { pending: 'awaiting_approval' } : { missing: true },
  } as unknown as Guard;
  const deps: GatewayDeps = {
    connector: connector as never,
    guard,
    audit: async () => {
      if (opts.auditFails) throw new Error('db down');
    },
    approvalUrl: (id) => `http://dash/approvals/${id}`,
    approvalTimeoutMs: 120_000,
  };
  return { deps, forwarded, guarded };
}

async function connect(deps: GatewayDeps, agentId = 'ops-agent') {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gatewayServer(
    deps,
    agentId,
    () => 'sess1',
    async () => [{ name: 'get_order', inputSchema: { type: 'object' } }],
  ).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: r.isError ?? false, body: JSON.parse(r.content[0]?.text ?? '{}') };
  };
  return { client, call };
}

describe('gateway mcp server', () => {
  it('lists upstream tools plus the approval check', async () => {
    const { client } = await connect(setup().deps);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'get_order',
      'warden_check_approval',
    ]);
  });

  it('forwards reads straight to the connector', async () => {
    const s = setup();
    const { call } = await connect(s.deps);
    expect(await call('get_order', { id: 'O1' })).toEqual({ isError: false, body: { id: 'X' } });
    expect(s.forwarded).toEqual(['get_order']);
  });

  it('sends money calls through the guard with the looked-up amount', async () => {
    const s = setup();
    const { call } = await connect(s.deps);
    const r = await call('create_refund', { capture_id: 'CAP123456789012345' });
    expect(s.forwarded).toEqual(['get_capture']);
    expect(s.guarded[0]?.intent).toMatchObject({
      tool: 'create_refund',
      tier: 'TIER_MONEY_OUT',
      agentId: 'ops-agent',
      sessionId: 'sess1',
      amount: { value: '89.00', currency: 'USD' },
    });
    expect(r).toMatchObject({
      isError: true,
      body: { warden: { outcome: 'deny', code: 'OVER_DAILY_BUDGET', message: 'too much' } },
    });
  });

  it('refuses tools it has no tier for', async () => {
    const s = setup();
    const { call } = await connect(s.deps);
    expect((await call('drain_account')).body.warden.code).toBe('TOOL_NOT_AVAILABLE');
    expect(s.forwarded).toEqual([]);
  });

  it('sends nothing it could not record', async () => {
    const s = setup({ auditFails: true });
    const { call } = await connect(s.deps);
    expect((await call('get_order', { id: 'O1' })).body.warden.code).toBe('AUDIT_UNAVAILABLE');
    expect((await call('send_payout', { receiver_email: 'a@b.co' })).body.warden.code).toBe(
      'AUDIT_UNAVAILABLE',
    );
    expect(s.forwarded).toEqual([]);
    expect(s.guarded).toEqual([]);
  });

  it('only shows a pending call to the agent that made it', async () => {
    const mine = await connect(setup().deps, 'ops-agent');
    expect((await mine.call('warden_check_approval', { callId: 'c_1' })).body.warden.code).toBe(
      'PENDING_APPROVAL',
    );
    const theirs = await connect(setup().deps, 'other-agent');
    expect((await theirs.call('warden_check_approval', { callId: 'c_1' })).body.warden.code).toBe(
      'UNKNOWN_CALL',
    );
  });
});
