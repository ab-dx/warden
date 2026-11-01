// end-to-end check against a running connector and the paypal sandbox.
// usage: pnpm smoke   (needs CONNECTOR_TOKEN and a seeded .seed/sandbox.json)
import { readFile } from 'node:fs/promises';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { ConnectorService } from '@warden/contracts';

const url = `http://localhost:${process.env.CONNECTOR_PORT ?? 7001}`;
const transport = (token: string) =>
  createConnectTransport({
    baseUrl: url,
    httpVersion: '1.1',
    interceptors: [
      (next) => (req) => {
        req.header.set('authorization', `Bearer ${token}`);
        return next(req);
      },
    ],
  });

const client = createClient(ConnectorService, transport(process.env.CONNECTOR_TOKEN ?? ''));
const seed = JSON.parse(await readFile('../../.seed/sandbox.json', 'utf8')) as {
  orders: { orderId: string; captureId: string }[];
};
const [first] = seed.orders;
if (!first) throw new Error('run pnpm paypal:seed first');
const key = () => `smoke_${crypto.randomUUID().replaceAll('-', '')}`;

const { tools } = await client.listTools({});
console.log(`tools: ${tools.length} (send_payout: ${tools.some((t) => t.name === 'send_payout')})`);

const show = (
  label: string,
  r: { ok: boolean; upstreamRef?: string | undefined; errorCode?: string | undefined },
) =>
  console.log(
    `${label.padEnd(26)} ok=${r.ok} ref=${r.upstreamRef ?? '-'} error=${r.errorCode ?? '-'}`,
  );

show(
  'get_order',
  await client.callTool({
    callId: 'c1',
    tool: 'get_order',
    arguments: { id: first.orderId },
    idempotencyKey: key(),
  }),
);
show(
  'create_refund 1.00',
  await client.callTool({
    callId: 'c2',
    tool: 'create_refund',
    arguments: { capture_id: first.captureId, amount: { currency_code: 'USD', value: '1.00' } },
    idempotencyKey: key(),
  }),
);
show(
  'create_refund 9999.00',
  await client.callTool({
    callId: 'c3',
    tool: 'create_refund',
    arguments: { capture_id: first.captureId, amount: { currency_code: 'USD', value: '9999.00' } },
    idempotencyKey: key(),
  }),
);
show(
  'send_payout 1.00',
  await client.callTool({
    callId: 'c4',
    tool: 'send_payout',
    arguments: {
      receiver_email: process.env.DEMO_CONTRACTOR_EMAIL ?? '',
      amount: { value: '1.00', currency_code: 'USD' },
    },
    idempotencyKey: key(),
  }),
);
show(
  'send_payout bad amount',
  await client.callTool({
    callId: 'c5',
    tool: 'send_payout',
    arguments: { receiver_email: 'a@b.co', amount: { value: '1e3', currency_code: 'USD' } },
    idempotencyKey: key(),
  }),
);
show(
  'unknown tool',
  await client.callTool({
    callId: 'c6',
    tool: 'drain_account',
    arguments: {},
    idempotencyKey: key(),
  }),
);

try {
  await createClient(ConnectorService, transport('wrong')).listTools({});
  console.log('wrong token: ACCEPTED (bad)');
} catch (err) {
  console.log(`wrong token: rejected (${(err as Error).message.slice(0, 40)})`);
}
