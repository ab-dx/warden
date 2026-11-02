import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import type { Evaluation, Forwarded, GuardEvent, GuardInput } from '@warden/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Activities } from './activities.js';
import { decideSignal, paymentGuard } from './workflow.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  // several tests fail activities on purpose
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

type Script = {
  evaluate: () => Promise<Evaluation>;
  forward?: () => Promise<Forwarded>;
};

function fakes(script: Script) {
  const log: string[] = [];
  const events: GuardEvent[] = [];
  const activities: Activities = {
    evaluate: async () => script.evaluate(),
    forward: async () => {
      log.push('forward');
      return (script.forward ?? (async () => ({ ok: true, content: [], upstreamRef: 'R1' })))();
    },
    settle: async (id) => void log.push(`settle:${id}`),
    release: async (id, reason) => void log.push(`release:${id}:${reason}`),
    emit: async (e) => void events.push(e),
  };
  return { activities, log, events };
}

const input = (callId: string, extra: Partial<GuardInput> = {}): GuardInput => ({
  callId,
  tool: 'create_refund',
  args: { capture_id: 'CAP1' },
  intent: { callId, tool: 'create_refund', amount: { value: '40.00', currency: 'USD' } },
  ...extra,
});

type Signal = (d: { approved: boolean; by: string }) => Promise<void>;

async function run(
  script: Script,
  callId: string,
  drive?: (h: { signal: Signal }) => Promise<void>,
  extra: Partial<GuardInput> = {},
) {
  const f = fakes(script);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: callId,
    workflowsPath: fileURLToPath(new URL('./workflow.ts', import.meta.url)),
    activities: f.activities,
  });
  const result = await worker.runUntil(async () => {
    const h = await env.client.workflow.start(paymentGuard, {
      taskQueue: callId,
      workflowId: callId,
      args: [input(callId, extra)],
    });
    if (drive) await drive({ signal: (d) => h.signal(decideSignal, d) });
    return h.result();
  });
  return { result, ...f };
}
const reason = (code: string) => ({ code, message: code, check: 'policy' });

describe('paymentGuard', () => {
  it('forwards an allowed call and settles its reservation', async () => {
    const r = await run(
      { evaluate: async () => ({ outcome: 'allow', reasons: [], reservationId: 'res1' }) },
      'allow',
    );
    expect(r.result).toMatchObject({ outcome: 'allow', decidedBy: 'policy', result: { ok: true } });
    expect(r.log).toEqual(['forward', 'settle:res1']);
    expect(r.events.map((e) => e.kind)).toEqual(['decisionMade', 'paymentExecuted']);
  });

  it('never forwards a denied call and releases any hold', async () => {
    const r = await run(
      {
        evaluate: async () => ({
          outcome: 'deny',
          reasons: [reason('OVER_CAP')],
          reservationId: 'res2',
        }),
      },
      'deny',
    );
    expect(r.result).toMatchObject({ outcome: 'deny', reasons: [{ code: 'OVER_CAP' }] });
    expect(r.log).toEqual(['release:res2:denied']);
  });

  it('denies when the policy service is down', async () => {
    const r = await run(
      {
        evaluate: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
      'policy-down',
    );
    expect(r.result).toMatchObject({ outcome: 'deny', reasons: [{ code: 'CHECK_FAILED' }] });
    expect(r.log).not.toContain('forward');
  });

  it('holds an escalated call until a human approves it', async () => {
    const r = await run(
      {
        evaluate: async () => ({
          outcome: 'escalate',
          reasons: [reason('NEW_PAYEE')],
          reservationId: 'res3',
        }),
      },
      'approve',
      async ({ signal }) => signal({ approved: true, by: 'priya' }),
    );
    expect(r.result).toMatchObject({ outcome: 'allow', decidedBy: 'human' });
    expect(r.log).toEqual(['forward', 'settle:res3']);
    expect(r.events.map((e) => e.kind)).toEqual([
      'approvalRequested',
      'approvalResolved',
      'decisionMade',
      'paymentExecuted',
    ]);
  });

  it('keeps the first answer when a second one arrives', async () => {
    const r = await run(
      { evaluate: async () => ({ outcome: 'escalate', reasons: [] }) },
      'first-wins',
      async ({ signal }) => {
        await signal({ approved: false, by: 'priya' });
        await signal({ approved: true, by: 'attacker' });
      },
    );
    expect(r.result).toMatchObject({ outcome: 'deny', reasons: [{ code: 'APPROVAL_REJECTED' }] });
    expect(r.log).not.toContain('forward');
  });

  it('denies and releases when nobody answers in time', async () => {
    const r = await run(
      { evaluate: async () => ({ outcome: 'escalate', reasons: [], reservationId: 'res4' }) },
      'timeout',
      undefined,
      { approvalTimeoutMs: 120_000 },
    );
    expect(r.result).toMatchObject({
      outcome: 'deny',
      decidedBy: 'timeout',
      reasons: [{ code: 'APPROVAL_TIMEOUT' }],
    });
    expect(r.log).toEqual(['release:res4:denied']);
  });

  it('releases the hold when paypal rejects the call', async () => {
    const r = await run(
      {
        evaluate: async () => ({ outcome: 'allow', reasons: [], reservationId: 'res5' }),
        forward: async () => ({ ok: false, content: [], errorCode: 'PAYPAL_API_HTTP_ERROR' }),
      },
      'upstream-fail',
    );
    expect(r.result).toMatchObject({ outcome: 'allow', result: { ok: false } });
    expect(r.log).toEqual(['forward', 'release:res5:upstream failed: PAYPAL_API_HTTP_ERROR']);
  });

  it('keeps the hold and does not retry when the outcome is unknown', async () => {
    let calls = 0;
    const r = await run(
      {
        evaluate: async () => ({ outcome: 'allow', reasons: [], reservationId: 'res6' }),
        forward: async () => {
          calls++;
          throw new Error('socket hang up');
        },
      },
      'unknown',
    );
    expect(r.result).toMatchObject({ result: { ok: false, errorCode: 'OUTCOME_UNKNOWN' } });
    expect(calls).toBe(1);
    expect(r.log.filter((l) => l.startsWith('release') || l.startsWith('settle'))).toEqual([]);
  });
});
