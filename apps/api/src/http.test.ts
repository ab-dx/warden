import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiController, DEPS, type Deps, SessionController } from './http.js';
import { sessions } from './session.js';

let base: string;
let close: () => Promise<void>;
const signals: unknown[] = [];
let waitingStatus = 'awaiting_approval';

beforeAll(async () => {
  const temporal = {
    workflow: {
      getHandle: () => ({
        describe: async () => ({ status: { name: 'RUNNING' } }),
        query: async () => waitingStatus,
        signal: async (_name: string, d: unknown) => void signals.push(d),
      }),
    },
  };
  const deps: Deps = {
    sessions: sessions({
      secret: 's'.repeat(32),
      password: 'correct horse battery',
      user: 'priya',
      ttlMs: 60_000,
    }),
    ledger: {} as never,
    policy: {} as never,
    temporal: temporal as never,
    secureCookie: false,
  };
  @Module({
    controllers: [SessionController, ApiController],
    providers: [{ provide: DEPS, useValue: deps }],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
  close = () => app.close();
});

afterAll(async () => close?.());

const json = { 'content-type': 'application/json' };

async function signIn(password = 'correct horse battery') {
  const r = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ password }),
  });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}

const approve = (headers: Record<string, string>, body = '{"approved":true}') =>
  fetch(`${base}/api/approvals/c_1`, { method: 'POST', headers, body });

describe('approvals over http', () => {
  it('refuses a wrong password', async () => {
    expect((await signIn('guess')).status).toBe(401);
  });

  it('refuses to approve without a session', async () => {
    expect((await approve(json)).status).toBe(401);
    expect(signals).toEqual([]);
  });

  it('refuses a cross-site form post even with the cookie', async () => {
    const { cookie } = await signIn();
    const r = await approve(
      { cookie: cookie ?? '', 'content-type': 'application/x-www-form-urlencoded' },
      'approved=true',
    );
    expect(r.status).toBe(415);
    expect(signals).toEqual([]);
  });

  it('records who approved', async () => {
    const { cookie } = await signIn();
    const r = await approve({ ...json, cookie: cookie ?? '' });
    expect(r.status).toBe(202);
    expect(signals).toEqual([{ approved: true, by: 'dashboard:priya' }]);
  });

  it('says so when the payment is no longer waiting', async () => {
    waitingStatus = 'denied';
    const { cookie } = await signIn();
    expect((await approve({ ...json, cookie: cookie ?? '' })).status).toBe(409);
    waitingStatus = 'awaiting_approval';
  });

  it('rejects a body that is not a clear yes or no', async () => {
    const { cookie } = await signIn();
    expect((await approve({ ...json, cookie: cookie ?? '' }, '{"approved":"yes"}')).status).toBe(
      400,
    );
  });
});
