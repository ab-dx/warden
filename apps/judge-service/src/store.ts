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
`;

export async function record(
  tx: Pick<pg.ClientBase, 'query'>,
  e: { sessionId: string; sourceTool: string; tokens: string[] },
) {
  if (!e.sessionId || e.tokens.length === 0) return;
  await tx.query(
    `insert into observed (session_id, token, source_tool)
     select $1, t, $2 from unnest($3::text[]) as t
     on conflict do nothing`,
    [e.sessionId, e.sourceTool, e.tokens],
  );
}

export async function seen(pool: pg.Pool, sessionId: string): Promise<string[]> {
  const { rows } = await pool.query<{ token: string }>(
    'select token from observed where session_id = $1',
    [sessionId],
  );
  return rows.map((r) => r.token);
}
