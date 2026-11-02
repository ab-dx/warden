import 'reflect-metadata';
import { expressConnectMiddleware } from '@connectrpc/connect-express';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PolicyService } from '@warden/contracts';
import { requireBearer } from '@warden/service-kit';
import pg from 'pg';
import { loadConfig } from './config.js';
import { loadPolicyFile } from './engine/policy-file.js';
import { policyService } from './service.js';
import { PolicyStore } from './store.js';

@Controller()
class HealthController {
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
class AppModule {}

const config = loadConfig();
const policyFile = await loadPolicyFile(config.POLICY_FILE);
const pool = new pg.Pool({ connectionString: config.POLICY_DATABASE_URL, max: 20 });
const store = new PolicyStore(pool, policyFile);
await store.migrate();

const app = await NestFactory.create(AppModule, { bodyParser: false });
app.enableShutdownHooks();
app.use(`/${PolicyService.typeName}`, requireBearer(config.POLICY_TOKEN));
app.use(
  expressConnectMiddleware({
    routes: (r) => r.service(PolicyService, policyService(store, policyFile)),
  }),
);
await app.listen(config.POLICY_PORT);
Logger.log(
  `policy-service listening on ${config.POLICY_PORT} (agents: ${Object.keys(policyFile.agents).join(', ')})`,
  'main',
);
