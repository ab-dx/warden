export type ToolContent = { type: string; text?: string; [k: string]: unknown }[];

export type Classified = {
  ok: boolean;
  upstreamRef?: string | undefined;
  errorCode?: string | undefined;
};

// paypal's mcp server reports failures as isError: false with an error body,
// e.g. {"ok":false,"code":"PAYPAL_API_HTTP_ERROR"} or {"error":{"type":"paypal_error"}}.
// anything we can't positively read as success is a failure.
// takes the raw callTool result, which can also be the legacy { toolResult } shape
export function classify(result: Record<string, unknown>): Classified {
  const content = Array.isArray(result.content) ? (result.content as ToolContent) : [];
  const texts = content.filter((c) => c.type === 'text' && typeof c.text === 'string');
  if (result.isError === true)
    return { ok: false, errorCode: errorCodeOf(texts) ?? 'UPSTREAM_ERROR' };
  if (texts.length === 0) return { ok: false, errorCode: 'EMPTY_RESULT' };

  const bodies = texts.map((t) => parse(t.text as string));
  if (bodies.some((b) => b === undefined)) return { ok: false, errorCode: 'UNREADABLE_RESULT' };
  if (bodies.some((b) => b?.ok === false || b?.error !== undefined)) {
    return { ok: false, errorCode: errorCodeOf(texts) ?? 'UPSTREAM_ERROR' };
  }
  const id = bodies.find((b) => typeof b?.id === 'string')?.id as string | undefined;
  return id ? { ok: true, upstreamRef: id } : { ok: true };
}

function errorCodeOf(texts: ToolContent): string | undefined {
  for (const t of texts) {
    const body = parse(t.text as string);
    const code = body?.code ?? (body?.error as { type?: unknown } | undefined)?.type;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
