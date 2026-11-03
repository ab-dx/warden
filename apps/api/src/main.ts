import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Connection, Client as TemporalClient } from '@temporalio/client';
import { LedgerService, PolicyService } from '@warden/contracts';
import { internalClient } from '@warden/service-kit';
import { z } from 'zod';
import { ApiController, DEPS, type Deps, SessionController } from './http.js';
import { sessions } from './session.js';

const env = z
  .object({
    API_PORT: z.coerce.number().int().positive().default(7005),
    DASHBOARD_USER: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .default('owner'),
    DASHBOARD_PASSWORD: z.string().min(12),
    SESSION_SECRET: z.string().min(32),
    SESSION_HOURS: z.coerce.number().positive().default(12),
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    LEDGER_URL: z.url().default('http://localhost:7004'),
    LEDGER_TOKEN: z.string().min(32),
    POLICY_URL: z.url().default('http://localhost:7003'),
    POLICY_TOKEN: z.string().min(32),
    TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    DASHBOARD_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../dashboard/dist', import.meta.url))),
  })
  .safeParse(process.env);
if (!env.success)
  throw new Error(
    `invalid api config: ${env.error.issues.map((i) => i.path.join('.')).join(', ')}`,
  );
const c = env.data;

const deps: Deps = {
  sessions: sessions({
    secret: c.SESSION_SECRET,
    password: c.DASHBOARD_PASSWORD,
    user: c.DASHBOARD_USER,
    ttlMs: c.SESSION_HOURS * 3600_000,
  }),
  ledger: internalClient(LedgerService, c.LEDGER_URL, c.LEDGER_TOKEN),
  policy: internalClient(PolicyService, c.POLICY_URL, c.POLICY_TOKEN),
  temporal: new TemporalClient({
    connection: await Connection.connect({ address: c.TEMPORAL_ADDRESS }),
    namespace: c.TEMPORAL_NAMESPACE,
  }),
  secureCookie: c.COOKIE_SECURE === 'true',
};

@Module({
  controllers: [SessionController, ApiController],
  providers: [{ provide: DEPS, useValue: deps }],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.enableShutdownHooks();
app
  .getHttpAdapter()
  .getInstance()
  .get('/healthz', (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ status: 'ok' }),
  );

if (existsSync(c.DASHBOARD_DIR)) {
  app.useStaticAssets(c.DASHBOARD_DIR);
  // client-side routes all load the same page
  app
    .getHttpAdapter()
    .getInstance()
    .get(/^\/(?!api\/|healthz).*/, (_req: unknown, res: { sendFile: (p: string) => void }) =>
      res.sendFile(`${c.DASHBOARD_DIR}/index.html`),
    );
} else {
  Logger.warn(`no dashboard build at ${c.DASHBOARD_DIR}; serving the api only`, 'main');
}

await app.listen(c.API_PORT);
Logger.log(`api and dashboard on :${c.API_PORT}`, 'main');
