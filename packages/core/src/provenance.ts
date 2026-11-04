// pulls the things a payment could be aimed at out of text the agent read: email
// addresses, dollar amounts and paypal ids. tokens are prefixed so an amount can never
// match an id, and normalised the same way the gateway normalises a payment intent.

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// "$1,200", "$96.00", "USD 40", "40.00 USD"
const AMOUNT =
  /(?:\$|\bUSD\s?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?USD\b/gi;
// capture, order, dispute and batch ids are 13 to 20 upper-case letters and digits
const PAYPAL_ID = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{13,20}\b/g;

export const amountToken = (whole: string, frac = '') =>
  `amount:${whole.replaceAll(',', '').replace(/^0+(?=\d)/, '')}.${frac.padEnd(2, '0')}`;
export const emailToken = (email: string) => `email:${email.toLowerCase()}`;
export const idToken = (id: string) => `id:${id}`;

export function contentTokens(text: string): string[] {
  const out = new Set<string>();
  for (const [e] of text.matchAll(EMAIL)) out.add(emailToken(e));
  for (const m of text.matchAll(AMOUNT)) {
    const whole = m[1] ?? m[3];
    if (whole) out.add(amountToken(whole, m[2] ?? m[4]));
  }
  for (const [id] of text.matchAll(PAYPAL_ID)) out.add(idToken(id));
  return [...out].sort();
}

// a payee the agent read in untrusted content that appears nowhere the user wrote
// (mandate tasks and payee lists). refunds, disputes and orders name ids instead, and
// their money can only go back to the original payer, so only email payees count.
export function payeeOnlyFromUntrusted(
  payee: string | undefined,
  seen: readonly string[],
  userText: readonly string[],
): boolean {
  if (!payee?.includes('@')) return false;
  const t = emailToken(payee);
  if (!seen.includes(t)) return false;
  return !userText.some((text) => contentTokens(text).includes(t));
}
