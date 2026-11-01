// thin sandbox rest client for scripts. throws with paypal's debug id so failures are traceable.
export function paypalRest(token: string) {
  const base = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
  if (!base.includes('sandbox')) throw new Error(`refusing non-sandbox api base: ${base}`);

  return async <T>(
    method: string,
    path: string,
    body?: unknown,
    requestId?: string,
  ): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
        ...(requestId ? { 'paypal-request-id': requestId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const issue = (json.details as { issue?: string }[] | undefined)?.[0]?.issue ?? json.name;
      throw new Error(
        `${method} ${path} -> ${res.status} ${issue ?? ''} (debug_id ${json.debug_id})`,
      );
    }
    return json as T;
  };
}
