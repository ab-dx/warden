import type { JsonObject } from '@bufbuild/protobuf';
import type { Client as RpcClient } from '@connectrpc/connect';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ConnectorService, GuardInput, Json } from '@warden/contracts';
import type { Guard, Held } from './guard.js';
import { buildIntent, intentJson, newCallId, redact } from './intent.js';
import { type Lookup, normalise, TIERS } from './registry.js';
import { denied, finished, pending, type ToolResult } from './render.js';

export type Audit = (e: {
  callId: string;
  intent: ReturnType<typeof buildIntent>;
  redactedArgs: unknown;
}) => Promise<void>;

export type GatewayDeps = {
  connector: RpcClient<typeof ConnectorService>;
  guard: Guard;
  audit: Audit;
  approvalUrl: (callId: string) => string;
  approvalTimeoutMs: number;
};

const CHECK_TOOL: Tool = {
  name: 'warden_check_approval',
  description: 'Get the result of a payment that was waiting for the user to approve it.',
  inputSchema: {
    type: 'object',
    properties: {
      callId: { type: 'string', description: 'The callId from the pending response.' },
    },
    required: ['callId'],
  },
};

// the upstream tool list barely changes, so don't ask the connector on every list
const TOOL_CACHE_MS = 60_000;

export function toolLister(connector: GatewayDeps['connector']) {
  let cached: { at: number; tools: Tool[] } | undefined;
  return async (): Promise<Tool[]> => {
    if (cached && Date.now() - cached.at < TOOL_CACHE_MS) return cached.tools;
    const { tools } = await connector.listTools({});
    const known = tools
      .filter((t) => t.name in TIERS)
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Tool['inputSchema'],
      }));
    cached = { at: Date.now(), tools: known };
    return known;
  };
}

function render(callId: string, held: Held, approvalUrl: string): ToolResult {
  if ('done' in held) return finished(callId, held.done);
  if ('pending' in held) return pending(callId, approvalUrl);
  if ('failed' in held) {
    return denied(
      callId,
      [
        {
          code: 'OUTCOME_UNKNOWN',
          message: 'Warden could not confirm what happened to this call. Do not retry it.',
          check: 'gateway',
        },
      ],
      'unknown',
    );
  }
  return denied(callId, [
    {
      code: 'UNKNOWN_CALL',
      message: 'No call with this id exists for this agent.',
      check: 'gateway',
    },
  ]);
}

export function gatewayServer(
  deps: GatewayDeps,
  agentId: string,
  sessionId: () => string,
  listTools: () => Promise<Tool[]>,
) {
  const server = new Server({ name: 'warden', version: '0.1.0' }, { capabilities: { tools: {} } });

  const lookup: Lookup = async (tool, args) => {
    const r = await deps.connector.callTool({
      callId: newCallId(),
      tool,
      arguments: args as JsonObject,
      idempotencyKey: newCallId(),
    });
    const text = (r.content[0] as { text?: unknown } | undefined)?.text;
    if (!r.ok || typeof text !== 'string') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...(await listTools()), CHECK_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (name === CHECK_TOOL.name) {
      const callId = typeof args.callId === 'string' ? args.callId : '';
      return render(callId, await deps.guard.check(callId, agentId), deps.approvalUrl(callId));
    }

    const tier = TIERS[name];
    const callId = newCallId();
    if (!tier)
      return denied(callId, [
        {
          code: 'TOOL_NOT_AVAILABLE',
          message: `${name} is not available through Warden.`,
          check: 'gateway',
        },
      ]);

    const n = tier === 'T2' || tier === 'T3' ? await normalise(name, args, lookup) : { refs: {} };
    const intent = buildIntent(callId, agentId, sessionId(), name, tier, n);
    try {
      await deps.audit({ callId, intent, redactedArgs: redact(args) });
    } catch {
      // a call we can't record is a call we don't make
      return denied(callId, [
        {
          code: 'AUDIT_UNAVAILABLE',
          message: 'Warden could not record this call, so it was not sent.',
          check: 'gateway',
        },
      ]);
    }

    // shortcut: no-money writes (T1) skip policy and only get audited; route them through the guard if mandates need to scope them
    if (tier === 'T0' || tier === 'T1') {
      const r = await deps.connector.callTool({
        callId,
        tool: name,
        arguments: args as JsonObject,
        idempotencyKey: callId,
      });
      return { content: r.content, ...(r.ok ? {} : { isError: true }) };
    }

    const input: GuardInput = {
      callId,
      tool: name,
      args: args as { [k: string]: Json },
      intent: intentJson(intent),
      approvalTimeoutMs: deps.approvalTimeoutMs,
    };
    return render(callId, await deps.guard.run(input, agentId), deps.approvalUrl(callId));
  });

  return server;
}
