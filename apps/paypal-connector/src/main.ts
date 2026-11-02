import 'reflect-metadata';
import { expressConnectMiddleware } from '@connectrpc/connect-express';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConnectorService } from '@warden/contracts';
import { requireBearer } from '@warden/service-kit';
import { AppModule, CONFIG } from './app.module.js';
import type { Config } from './config.js';
import { connectorService } from './connector.js';
import { TokenProvider } from './token.js';
import { getCapture } from './upstream/captures.js';
import { PayPalMcp } from './upstream/mcp.js';
import { sendPayout } from './upstream/payouts.js';

const app = await NestFactory.create(AppModule, { bodyParser: false });
app.enableShutdownHooks();

const config = app.get<Config>(CONFIG);
const tokens = app.get(TokenProvider);
const impl = connectorService(
  app.get(PayPalMcp),
  (args, key) => sendPayout(config.PAYPAL_API_BASE, tokens, args, key),
  (args) => getCapture(config.PAYPAL_API_BASE, tokens, args),
);

// connect handles its own body parsing, so nest's parser is off above.
// unmatched paths fall through to nest (healthz).
app.use(`/${ConnectorService.typeName}`, requireBearer(config.CONNECTOR_TOKEN));
app.use(expressConnectMiddleware({ routes: (router) => router.service(ConnectorService, impl) }));

await app.listen(config.CONNECTOR_PORT);
Logger.log(`paypal-connector listening on ${config.CONNECTOR_PORT}`, 'main');
