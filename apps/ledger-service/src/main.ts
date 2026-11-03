import 'reflect-metadata';
import { expressConnectMiddleware } from '@connectrpc/connect-express';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LedgerService } from '@warden/contracts';
import { outboxSchemaSql } from '@warden/outbox';
import { requireBearer } from '@warden/service-kit';
import pg from 'pg';
import { z } from 'zod';
import { startConsumer } from './consumer.js';
import { ledgerService } from './service.js';
import { schemaSql } from './store.js';

const env = z
  .object({
    LEDGER_DATABASE_URL: z.string().default('postgres://ledger:warden@localhost:5432/ledger'),
    KAFKA_BROKERS: z.string().default('localhost:29092'),
    LEDGER_TOKEN: z.string().min(32),
    LEDGER_PORT: z.coerce.number().int().positive().default(7004),
  })
  .safeParse(process.env);
if (!env.success)
  throw new Error(
    `invalid ledger-service config: ${env.error.issues.map((i) => i.path.join('.')).join(', ')}`,
  );
const config = env.data;
const log = new Logger('ledger-service');

const pool = new pg.Pool({ connectionString: config.LEDGER_DATABASE_URL, max: 10 });
// the inbox table comes with the outbox schema
await pool.query(outboxSchemaSql);
await pool.query(schemaSql);
const consumer = await startConsumer({
  pool,
  brokers: config.KAFKA_BROKERS.split(','),
  groupId: 'ledger-service',
  onSkip: (reason) => log.warn(reason),
});

@Controller()
class HealthController {
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
class AppModule {}

const app = await NestFactory.create(AppModule, { bodyParser: false });
app.use(`/${LedgerService.typeName}`, requireBearer(config.LEDGER_TOKEN));
app.use(expressConnectMiddleware({ routes: (r) => r.service(LedgerService, ledgerService(pool)) }));
await app.listen(config.LEDGER_PORT);
log.log(`listening on ${config.LEDGER_PORT}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await consumer.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
