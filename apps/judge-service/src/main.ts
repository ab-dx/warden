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
import { chatCompletions, intentJudge } from './intent.js';
import { judgeService } from './service.js';
import { schemaSql, seen } from './store.js';

const env = z
  .object({
    JUDGE_DATABASE_URL: z.string().default('postgres://judge:warden@localhost:5432/judge'),
    KAFKA_BROKERS: z.string().default('localhost:29092'),
    JUDGE_TOKEN: z.string().min(32),
    JUDGE_PORT: z.coerce.number().int().positive().default(7006),
    // any openai-compatible endpoint; unset leaves only the provenance check on
    JUDGE_LLM_BASE_URL: z.preprocess((v) => v || undefined, z.url().optional()),
    JUDGE_LLM_MODEL: z.string().default(''),
    JUDGE_LLM_API_KEY: z.string().optional(),
    JUDGE_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    JUDGE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  })
  .safeParse(process.env);
if (!env.success)
  throw new Error(
    `invalid judge-service config: ${env.error.issues.map((i) => i.path.join('.')).join(', ')}`,
  );
const config = env.data;
const log = new Logger('judge-service');
if (config.JUDGE_LLM_BASE_URL && !config.JUDGE_LLM_MODEL)
  throw new Error('invalid judge-service config: JUDGE_LLM_MODEL');
const judge = config.JUDGE_LLM_BASE_URL
  ? intentJudge({
      complete: chatCompletions({
        baseUrl: config.JUDGE_LLM_BASE_URL,
        model: config.JUDGE_LLM_MODEL,
        apiKey: config.JUDGE_LLM_API_KEY,
        timeoutMs: config.JUDGE_LLM_TIMEOUT_MS,
      }),
      minConfidence: config.JUDGE_MIN_CONFIDENCE,
    })
  : undefined;
if (!judge) log.warn('no JUDGE_LLM_BASE_URL: the llm judge is off, provenance still runs');

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
        judgeService((id) => seen(pool, id), judge),
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
