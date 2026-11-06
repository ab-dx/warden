import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Controller, Delete, Get, Logger, Module, Post, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Connection, Client as TemporalClient } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry';
import { ConnectorService } from '@warden/contracts';
import { startOutbox } from '@warden/outbox';
import { internalClient } from '@warden/service-kit';
import type { Request, Response } from 'express';
import pg from 'pg';
import { agentKeys } from './agents.js';
import { outboxAudit, outboxObserve } from './audit.js';
import { loadConfig } from './config.js';
import { Guard } from './guard.js';
import { type GatewayDeps, gatewayServer, toolLister } from './mcp.js';
import { TIERS } from './registry.js';
import { untrustedServers } from './untrusted.js';

const config = loadConfig();
const log = new Logger('edge-gateway');
const pool = new pg.Pool({ connectionString: config.GATEWAY_DATABASE_URL, max: 20 });
const outbox = await startOutbox({
  pool,
  brokers: config.KAFKA_BROKERS.split(','),
  clientId: 'edge-gateway',
  lockKey: 0x67617465,
  onError: (err) => log.warn(`outbox relay: ${(err as Error).message}`),
});
const temporal = new TemporalClient({
  connection: await Connection.connect({ address: config.TEMPORAL_ADDRESS }),
  namespace: config.TEMPORAL_NAMESPACE,
  // carries the request's trace into the payment workflow
  interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
});
const connector = internalClient(ConnectorService, config.CONNECTOR_URL, config.CONNECTOR_TOKEN);
const deps: GatewayDeps = {
  connector,
  guard: new Guard(temporal, config.GUARD_TASK_QUEUE, config.GATEWAY_HOLD_MS),
  audit: outboxAudit(pool),
  untrusted: untrustedServers(
    config.UNTRUSTED_MCP_URLS,
    (name) => name in TIERS || name.startsWith('warden_'),
    (msg) => log.warn(msg),
  ),
  observe: outboxObserve(pool),
  approvalUrl: (id) => `${config.DASHBOARD_URL}/approvals/${id}`,
  approvalTimeoutMs: config.APPROVAL_TIMEOUT_MS,
};
const listTools = toolLister(connector);
const agentFor = agentKeys(config.WARDEN_AGENT_KEYS);
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; agentId: string }>();

@Controller()
class McpController {
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  @Post('mcp')
  async post(@Req() req: Request, @Res() res: Response) {
    const agentId = agentFor(req.headers.authorization);
    if (!agentId) return void res.status(401).json({ error: 'unknown agent key' });
    const sid = req.headers['mcp-session-id'];

    if (typeof sid === 'string') {
      const s = sessions.get(sid);
      // a session belongs to the agent that opened it
      if (!s || s.agentId !== agentId)
        return void res.status(404).json({ error: 'unknown session' });
      return s.transport.handleRequest(req, res, req.body);
    }
    if (!isInitializeRequest(req.body))
      return void res.status(400).json({ error: 'expected initialize' });

    let sessionId = '';
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessionId = id;
        sessions.set(id, { transport, agentId });
      },
    });
    transport.onclose = () => {
      if (sessionId) sessions.delete(sessionId);
    };
    await gatewayServer(deps, agentId, () => sessionId, listTools).connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  @Get('mcp')
  async stream(@Req() req: Request, @Res() res: Response) {
    await this.existing(req, res);
  }

  @Delete('mcp')
  async close(@Req() req: Request, @Res() res: Response) {
    await this.existing(req, res);
  }

  private async existing(req: Request, res: Response) {
    const agentId = agentFor(req.headers.authorization);
    const s = sessions.get(String(req.headers['mcp-session-id']));
    if (!agentId || !s || s.agentId !== agentId)
      return void res.status(404).json({ error: 'unknown session' });
    await s.transport.handleRequest(req, res);
  }
}

@Module({ controllers: [McpController] })
class AppModule {}

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(config.GATEWAY_PORT);
log.log(`mcp endpoint on :${config.GATEWAY_PORT}/mcp`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await outbox.stop();
    await pool.end();
    process.exit(0);
  });
}
