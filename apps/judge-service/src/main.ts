import 'reflect-metadata';
import { expressConnectMiddleware } from '@connectrpc/connect-express';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JudgeService } from '@warden/contracts';
import { outboxSchemaSql } from '@warden/outbox';
import { requireBearer } from '@warden/service-kit';
import pg from 'pg';
import { z } from 'zod';
import { startConsumer } from './consumer.js';
import { judgeService } from './service.js';
import { schemaSql, seen } from './store.js';

const env = z
  .object({
    JUDGE_DATABASE_URL: z.string().default('postgres://judge:warden@localhost:5432/judge'),
    KAFKA_BROKERS: z.string().default('localhost:29092'),
    JUDGE_TOKEN: z.string().min(32),
    JUDGE_PORT: z.coerce.number().int().positive().default(7006),
  })
  .safeParse(process.env);
if (!env.success)
  throw new Error(
    `invalid judge-service config: ${env.error.issues.map((i) => i.path.join('.')).join(', ')}`,
  );
const config = env.data;
const log = new Logger('judge-service');

const pool = new pg.Pool({ connectionString: config.JUDGE_DATABASE_URL, max: 10 });
// the inbox table comes with the outbox schema
await pool.query(outboxSchemaSql);
await pool.query(schemaSql);
const consumer = await startConsumer({
  pool,
  brokers: config.KAFKA_BROKERS.split(','),
  groupId: 'judge-service',
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
app.use(`/${JudgeService.typeName}`, requireBearer(config.JUDGE_TOKEN));
app.use(
  expressConnectMiddleware({
    routes: (r) =>
      r.service(
        JudgeService,
        judgeService((id) => seen(pool, id)),
      ),
  }),
);
await app.listen(config.JUDGE_PORT);
log.log(`listening on ${config.JUDGE_PORT}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await consumer.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
