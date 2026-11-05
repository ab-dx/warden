import type { Money } from './format.js';

export type Reason = { code: string; message: string; check: string };
export type Call = {
  callId: string;
  agentId?: string;
  tool?: string;
  tier?: string;
  amount?: Money;
  counterparty?: string;
  status: string;
  reasons?: Reason[];
  decidedBy?: string;
  upstreamRef?: string;
  receivedAt?: string;
  updatedAt?: string;
};
export type Approval = {
  call: Call;
  // warden's note for the owner, built from facts only; advice, not a verdict
  brief?: string;
  expiresAt: string | null;
  requestedAt: string | null;
};
export type Entry = {
  seq: string;
  type: string;
  occurredAt: string;
  producer: string;
  dataJson: string;
  prevHash: string;
  hash: string;
};
export type Mandate = {
  id: string;
  agentId: string;
  userId: string;
  task: string;
  maxPerCall: Money;
  maxTotal: Money;
  spent?: Money;
  reserved?: Money;
  counterparties?: string[];
  tools: string[];
  expiresAt: string;
  status: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      res.status,
      (data as { message?: string }).message ?? `Request failed (${res.status})`,
    );
  return data as T;
}

// a proposed mandate from the owner's words; only fills the form
export type Draft = {
  task: string;
  tools: string[];
  counterparties: string[];
  maxPerCall: string | null;
  maxTotal: string | null;
  expiresInMinutes: number | null;
  dropped: string[];
  namedPayees: boolean;
};

export const api = {
  me: () => call<{ user: string }>('GET', '/api/session'),
  login: (password: string) => call<void>('POST', '/api/session', { password }),
  logout: () => call<void>('DELETE', '/api/session'),
  approvals: () => call<Approval[]>('GET', '/api/approvals'),
  draftMandate: (text: string) => call<Draft>('POST', '/api/mandates/draft', { text }),
  decide: (callId: string, approved: boolean) =>
    call<void>('POST', `/api/approvals/${callId}`, { approved }),
  calls: () => call<Call[]>('GET', '/api/calls?limit=40'),
  call: (id: string) => call<{ call: Call; entries: Entry[] }>('GET', `/api/calls/${id}`),
  verify: () =>
    call<{ ok: boolean; entries: string; firstBadSeq?: string }>('GET', '/api/ledger/verify'),
  mandates: () => call<Mandate[]>('GET', '/api/mandates'),
  createMandate: (m: unknown) => call<Mandate>('POST', '/api/mandates', m),
  revoke: (id: string) => call<Mandate>('DELETE', `/api/mandates/${id}`),
};
