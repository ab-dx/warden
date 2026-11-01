// column names follow debezium's outbox event router (id, aggregatetype,
// aggregateid, type, payload) so switching the relay to cdc is config only.
// seq gives the relay a commit-order cursor; debezium ignores it.
export const outboxSchemaSql = `
create table if not exists outbox (
  seq bigserial primary key,
  id uuid not null unique,
  aggregatetype text not null,
  aggregateid text not null,
  type text not null,
  payload bytea not null,
  traceparent text,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists outbox_unpublished on outbox (seq) where published_at is null;

create or replace function outbox_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('outbox', '');
  return null;
end $$;
drop trigger if exists outbox_notify on outbox;
create trigger outbox_notify after insert on outbox for each statement execute function outbox_notify();

create table if not exists inbox (
  consumer text not null,
  event_id uuid not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, event_id)
);
`;
