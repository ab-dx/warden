import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiController, DEPS, type Deps, SessionController } from './http.js';
import { needsPasskey } from './passkey.js';
import { sessions } from './session.js';

let base: string;
let close: () => Promise<void>;
const revoked: string[] = [];
const signals: unknown[] = [];
let waitingStatus = 'awaiting_approval';
let callAmount = '50.00';
let passkeyRegistered = true;

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
    ledger: {
      getCall: async () => ({
        call: { callId: 'c_1', amount: { value: callAmount, currency: 'USD' } },
        entries: [],
      }),
    } as never,
    passkeys: {
      needs: (call: { amount?: { value: string; currency: string } }, approved: boolean) =>
        needsPasskey(call as never, approved, 10000n),
      registered: () => passkeyRegistered,
      check: async (_id: string, assertion: unknown) => assertion === 'good',
    } as never,
    policy: {
      revokeMandate: async ({ mandateId }: { mandateId: string }) => {
        revoked.push(mandateId);
        return {};
      },
    } as never,
    temporal: temporal as never,
    secureCookie: false,
    brief: async () => 'a note',
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

  it('revokes a mandate with a plain delete, which has no body to be json', async () => {
    const { cookie } = await signIn();
    const r = await fetch(`${base}/api/mandates/m_1`, {
      method: 'DELETE',
      headers: { cookie: cookie ?? '' },
    });
    expect(r.status).toBe(200);
    expect(revoked).toEqual(['m_1']);
  });

  it('needs the passkey to approve a big payment, but not to reject it', async () => {
    callAmount = '250.00';
    const { cookie } = await signIn();
    const headers = { ...json, cookie: cookie ?? '' };
    expect((await approve(headers)).status).toBe(428);
    expect((await approve(headers, '{"approved":true,"passkey":"forged"}')).status).toBe(403);
    passkeyRegistered = false;
    expect((await approve(headers, '{"approved":true,"passkey":"good"}')).status).toBe(403);
    passkeyRegistered = true;
    expect((await approve(headers, '{"approved":false}')).status).toBe(202);
    expect((await approve(headers, '{"approved":true,"passkey":"good"}')).status).toBe(202);
    callAmount = '50.00';
    signals.length = 0;
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
