#!/bin/bash
# one database and one login role per service, so no service can read another's tables
set -euo pipefail
for svc in gateway policy guard ledger api; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" <<SQL
CREATE ROLE ${svc} LOGIN PASSWORD '${SERVICE_DB_PASSWORD}';
CREATE DATABASE ${svc} OWNER ${svc};
REVOKE ALL ON DATABASE ${svc} FROM PUBLIC;
SQL
done
