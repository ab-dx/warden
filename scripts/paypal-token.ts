// mints a sandbox access token from client credentials. never point this at live.
export async function mintToken(): Promise<{ token: string; expiresIn: number }> {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  const base = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set');
  if (!base.includes('sandbox')) throw new Error(`refusing non-sandbox api base: ${base}`);

  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresIn: body.expires_in };
}
