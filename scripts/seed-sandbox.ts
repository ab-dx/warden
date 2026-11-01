// creates card-paid, captured orders so there is real money to refund.
// usage: pnpm paypal:seed [amount ...]   (defaults to the demo set)
import { mkdir, writeFile } from 'node:fs/promises';
import { paypalRest } from './paypal-rest.ts';
import { mintToken } from './paypal-token.ts';

type Order = {
  id: string;
  status: string;
  purchase_units: { payments?: { captures?: { id: string; status: string }[] } }[];
};

const amounts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['40.00', '45.00', '89.00', '120.00'];
for (const a of amounts)
  if (!/^\d+\.\d{2}$/.test(a)) throw new Error(`amount must look like 12.34: ${a}`);

const rest = paypalRest((await mintToken()).token);
const run = Date.now();
const seeded = [];

for (const [i, value] of amounts.entries()) {
  const order = await rest<Order>(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        { amount: { currency_code: 'USD', value }, description: `seed order ${i + 1}` },
      ],
      // paypal's sandbox test visa; captures immediately without a buyer redirect
      payment_source: {
        card: {
          number: '4111111111111111',
          expiry: '2030-12',
          name: 'Sandbox Buyer',
          security_code: '123',
        },
      },
    },
    `seed-${run}-${i}`,
  );
  const capture = order.purchase_units[0]?.payments?.captures?.[0];
  if (order.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') {
    throw new Error(`order ${order.id} not captured (status ${order.status})`);
  }
  seeded.push({ orderId: order.id, captureId: capture.id, amount: { value, currency: 'USD' } });
  console.log(`captured ${value} USD  order ${order.id}  capture ${capture.id}`);
}

await mkdir('.seed', { recursive: true });
await writeFile(
  '.seed/sandbox.json',
  `${JSON.stringify({ seededAt: new Date(run).toISOString(), orders: seeded }, null, 2)}\n`,
);
console.log(`wrote ${seeded.length} orders to .seed/sandbox.json`);
