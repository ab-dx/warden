import type { Pool, PoolClient } from 'pg';

// runs fn at most once per (consumer, event). the inbox row and fn's writes
// commit together, so a redelivered event after a crash is a no-op.
export async function handleOnce(
  pool: Pool,
  consumer: string,
  eventId: string,
  fn: (tx: PoolClient) => Promise<void>,
): Promise<boolean> {
  const tx = await pool.connect();
  try {
    await tx.query('begin');
    const { rowCount } = await tx.query(
      'insert into inbox (consumer, event_id) values ($1, $2) on conflict do nothing',
      [consumer, eventId],
    );
    if (rowCount === 0) {
      await tx.query('rollback');
      return false;
    }
    await fn(tx);
    await tx.query('commit');
    return true;
  } catch (err) {
    await tx.query('rollback');
    throw err;
  } finally {
    tx.release();
  }
}
