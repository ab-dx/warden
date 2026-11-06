import type pg from 'pg';

// what each agent session has read from untrusted tools, one row per token
export const schemaSql = `
create table if not exists observed (
  session_id text not null,
  token text not null,
  source_tool text not null,
  first_seen timestamptz not null default now(),
  primary key (session_id, token)
);
-- added later, so older databases get it here
alter table observed add column if not exists source_ref text not null default '';
`;

// a token and where the agent first read it
export type Observed = { token: string; sourceTool: string; sourceRef: string };

export async function record(
  tx: Pick<pg.ClientBase, 'query'>,
  e: { sessionId: string; sourceTool: string; sourceRef?: string; tokens: string[] },
) {
  if (!e.sessionId || e.tokens.length === 0) return;
  await tx.query(
    `insert into observed (session_id, token, source_tool, source_ref)
     select $1, t, $2, $3 from unnest($4::text[]) as t
     on conflict do nothing`,
    [e.sessionId, e.sourceTool, e.sourceRef ?? '', e.tokens],
  );
}

export async function seen(pool: pg.Pool, sessionId: string): Promise<Observed[]> {
  const { rows } = await pool.query<{ token: string; source_tool: string; source_ref: string }>(
    'select token, source_tool, source_ref from observed where session_id = $1',
    [sessionId],
  );
  return rows.map((r) => ({ token: r.token, sourceTool: r.source_tool, sourceRef: r.source_ref }));
}
