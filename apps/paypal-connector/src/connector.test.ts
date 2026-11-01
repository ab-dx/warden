import { describe, expect, it } from 'vitest';
import { connectorService } from './connector.js';

const mcp = {
  listTools: async () => [
    { name: 'create_refund', description: 'r', inputSchema: { type: 'object' } },
  ],
  callTool: async (name: string) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, code: 'PAYPAL_API_HTTP_ERROR', tool: name }),
      },
    ],
    isError: false,
  }),
};
const payout = async () => ({
  ok: true,
  upstreamRef: 'B1',
  content: [{ type: 'text' as const, text: '{}' }],
});

describe('connectorService', () => {
  const svc = connectorService(mcp as never, payout);
  const call = (tool: string) =>
    (
      svc.callTool as (
        r: unknown,
      ) => Promise<{ ok: boolean; errorCode?: string; upstreamRef?: string }>
    )({
      callId: 'c1',
      tool,
      arguments: {},
      idempotencyKey: 'call_abc123',
    });

  it('lists paypal tools plus the native payout tool', async () => {
    const { tools } = await (
      svc.listTools as () => Promise<{ tools: { name: string; upstream: string }[] }>
    )();
    expect(tools.map((t) => [t.name, t.upstream])).toEqual([
      ['create_refund', 'paypal-mcp'],
      ['send_payout', 'paypal-rest'],
    ]);
  });

  it('marks an upstream error body as not ok', async () => {
    expect(await call('create_refund')).toMatchObject({
      ok: false,
      errorCode: 'PAYPAL_API_HTTP_ERROR',
    });
  });

  it('routes payouts to the rest tool', async () => {
    expect(await call('send_payout')).toMatchObject({ ok: true, upstreamRef: 'B1' });
  });

  it('refuses tools that neither upstream has', async () => {
    expect(await call('drain_account')).toMatchObject({ ok: false, errorCode: 'UNKNOWN_TOOL' });
  });
});
