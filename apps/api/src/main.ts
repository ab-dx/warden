import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Connection, Client as TemporalClient } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry';
import { LedgerService, PolicyService } from '@warden/contracts';
import { signingKey } from '@warden/core';
import { internalClient } from '@warden/service-kit';
import { z } from 'zod';
import { decide, pendingApprovals } from './approvals.js';
import { briefs, chat } from './brief.js';
import { ApiController, DEPS, type Deps, SessionController } from './http.js';
import { sessions } from './session.js';
import { botApi, startTelegram, telegramApprovals } from './telegram.js';

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
    // both set: held payments are also sent to this chat with approve and reject buttons
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    // an empty line in .env means unset, not chat 0
    TELEGRAM_CHAT_ID: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce.number().int().optional(),
    ),
    // the owner's notes and mandate drafts reuse the judge's model; unset gives plain notes
    JUDGE_LLM_BASE_URL: z.string().optional(),
    JUDGE_LLM_MODEL: z.string().optional(),
    JUDGE_LLM_API_KEY: z.string().optional(),
    // a 32-byte base64url ed25519 seed; set it to sign mandates as verifiable tokens
    MANDATE_SIGNING_KEY: z.string().optional(),
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

const policy = internalClient(PolicyService, c.POLICY_URL, c.POLICY_TOKEN);
// the judge's model also writes the owner's notes and drafts mandates; both are advice
const complete =
  c.JUDGE_LLM_BASE_URL && c.JUDGE_LLM_MODEL
    ? chat({ baseUrl: c.JUDGE_LLM_BASE_URL, model: c.JUDGE_LLM_MODEL, apiKey: c.JUDGE_LLM_API_KEY })
    : undefined;
const deps: Deps = {
  sessions: sessions({
    secret: c.SESSION_SECRET,
    password: c.DASHBOARD_PASSWORD,
    user: c.DASHBOARD_USER,
    ttlMs: c.SESSION_HOURS * 3600_000,
  }),
  ledger: internalClient(LedgerService, c.LEDGER_URL, c.LEDGER_TOKEN),
  policy,
  temporal: new TemporalClient({
    connection: await Connection.connect({ address: c.TEMPORAL_ADDRESS }),
    namespace: c.TEMPORAL_NAMESPACE,
    // an approval signal joins the payment's trace
    interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
  }),
  secureCookie: c.COOKIE_SECURE === 'true',
  brief: briefs({
    mandates: async () => (await policy.listMandates({ agentId: '' })).mandates,
    complete,
  }),
  complete,
  signing: c.MANDATE_SIGNING_KEY ? signingKey(c.MANDATE_SIGNING_KEY) : undefined,
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
  )
  // the key that checks a signed mandate; public, since verifying needs no secret
  .get('/.well-known/jwks.json', (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ keys: deps.signing ? [deps.signing.jwk] : [] }),
  );

if (existsSync(c.DASHBOARD_DIR)) {
  app.useStaticAssets(c.DASHBOARD_DIR);
  // client-side routes all load the same page
  app
    .getHttpAdapter()
    .getInstance()
    .get(
      /^\/(?!api\/|healthz|\.well-known\/).*/,
      (_req: unknown, res: { sendFile: (p: string) => void }) =>
        res.sendFile(`${c.DASHBOARD_DIR}/index.html`),
    );
} else {
  Logger.warn(`no dashboard build at ${c.DASHBOARD_DIR}; serving the api only`, 'main');
}

await app.listen(c.API_PORT);
Logger.log(`api and dashboard on :${c.API_PORT}`, 'main');

if (c.TELEGRAM_BOT_TOKEN && c.TELEGRAM_CHAT_ID !== undefined) {
  const { ledger, temporal } = deps;
  startTelegram(
    telegramApprovals({
      bot: botApi(c.TELEGRAM_BOT_TOKEN),
      chatId: c.TELEGRAM_CHAT_ID,
      pending: async () =>
        Promise.all(
          (await pendingApprovals(ledger, temporal)).map(async (p) => ({
            ...p,
            brief: await deps.brief(p.call),
          })),
        ),
      decide: (callId, approved, by) => decide(temporal, callId, approved, by),
    }),
    (msg) => Logger.warn(msg, 'telegram'),
  );
  Logger.log('approvals also go to telegram', 'main');
}
