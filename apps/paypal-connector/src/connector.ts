import type { JsonObject } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import type { ConnectorService } from '@warden/contracts';
import { getCaptureTool } from './upstream/captures.js';
import type { PayPalMcp } from './upstream/mcp.js';
import { type sendPayout, sendPayoutTool } from './upstream/payouts.js';
import { classify } from './upstream/result.js';

type Payout = (args: unknown, idempotencyKey: string) => ReturnType<typeof sendPayout>;
type Capture = (args: unknown) => ReturnType<typeof sendPayout>;

// tools warden serves over paypal's rest api because the mcp server lacks them
const NATIVE = [sendPayoutTool, getCaptureTool];

// routes each call to paypal's mcp server or to a native rest tool. it decides
// nothing about whether a call should happen; that is the guard's job.
export function connectorService(
  mcp: Pick<PayPalMcp, 'listTools' | 'callTool'>,
  payout: Payout,
  capture: Capture,
): ServiceImpl<typeof ConnectorService> {
  let upstreamNames: Set<string> | undefined;

  const listUpstream = async () => {
    const tools = await mcp.listTools();
    upstreamNames = new Set(tools.map((t) => t.name));
    return tools;
  };

  return {
    async listTools() {
      const upstream = await listUpstream();
      return {
        tools: [
          ...upstream.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema as JsonObject,
            upstream: 'paypal-mcp',
          })),
          ...NATIVE.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: structuredClone(t.inputSchema) as unknown as JsonObject,
            upstream: 'paypal-rest',
          })),
        ],
      };
    },

    async callTool(req) {
      const args = req.arguments ?? {};
      if (req.tool === sendPayoutTool.name || req.tool === getCaptureTool.name) {
        const r =
          req.tool === sendPayoutTool.name
            ? await payout(args, req.idempotencyKey)
            : await capture(args);
        return { ok: r.ok, content: r.content, upstreamRef: r.upstreamRef, errorCode: r.errorCode };
      }

      if (!(upstreamNames ?? new Set((await listUpstream()).map((t) => t.name))).has(req.tool)) {
        return {
          ok: false,
          errorCode: 'UNKNOWN_TOOL',
          content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'UNKNOWN_TOOL' }) }],
        };
      }
      const result = await mcp.callTool(req.tool, args);
      const c = classify(result);
      return {
        ok: c.ok,
        content: (Array.isArray(result.content) ? result.content : []) as JsonObject[],
        upstreamRef: c.upstreamRef,
        errorCode: c.errorCode,
      };
    },
  };
}
