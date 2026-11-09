import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { llmBrain } from './llm.js';

const reply = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [{ id: 't1', function: { name: 'list_emails', arguments: '{}' } }],
      },
    },
  ],
};

let close = () => {};
afterEach(() => close());

// answers each request with the next step in the script
async function server(script: ((res: ServerResponse) => void)[]) {
  let hits = 0;
  const s = createServer((req, res) => {
    req.resume();
    const step = script[Math.min(hits++, script.length - 1)];
    step?.(res);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  close = () => s.close();
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { brain: llmBrain({ baseUrl: url, model: 'm', backoffMs: 1 }), hits: () => hits };
}

const ok = (res: ServerResponse) => res.end(JSON.stringify(reply));
const status = (code: number) => (res: ServerResponse) => {
  res.statusCode = code;
  res.end('{}');
};
const drop = (res: ServerResponse) => res.socket?.destroy();

describe('llmBrain', () => {
  it('rides out a dropped connection and a server error', async () => {
    const s = await server([drop, status(503), ok]);
    const turn = await s.brain.next([], []);
    expect(turn.calls.map((c) => c.name)).toEqual(['list_emails']);
    expect(s.hits()).toBe(3);
  });

  it('gives up after three tries', async () => {
    const s = await server([status(429)]);
    await expect(s.brain.next([], [])).rejects.toThrow(/returned 429/);
    expect(s.hits()).toBe(3);
  });

  it("says what the provider said when there's no choice in the answer", async () => {
    const s = await server([
      (res) => res.end(JSON.stringify({ error: { message: 'tool use not supported' } })),
    ]);
    await expect(s.brain.next([], [])).rejects.toThrow(/tool use not supported/);
  });

  it('does not retry a bad key', async () => {
    const s = await server([status(401)]);
    await expect(s.brain.next([], [])).rejects.toThrow(/returned 401/);
    expect(s.hits()).toBe(1);
  });
});
