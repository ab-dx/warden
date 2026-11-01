export type MintedToken = { token: string; expiresIn: number };

// refresh this long before paypal's expiry so an in-flight call never carries a dead token
const MARGIN_MS = 5 * 60_000;

export class TokenProvider {
  private current: { token: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly mint: () => Promise<MintedToken>,
    private readonly now: () => number = Date.now,
    private readonly retryDelayMs = 250,
  ) {}

  async get(): Promise<string> {
    if (this.current && this.now() < this.current.expiresAt - MARGIN_MS) return this.current.token;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { token, expiresIn } = await this.mint();
        this.current = { token, expiresAt: this.now() + expiresIn * 1000 };
        return token;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
      }
    }
    throw new Error(`could not mint a paypal token: ${(lastErr as Error).message}`);
  }
}

export function clientCredentialsMint(base: string, clientId: string, secret: string) {
  return async (): Promise<MintedToken> => {
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });
    // the body can echo request details, so keep only the status
    if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    return { token: body.access_token, expiresIn: body.expires_in };
  };
}
