#!/usr/bin/env bash
# Recreate the local test database and apply the stub + all migrations in order.
set -euo pipefail
DB=${DSP_TEST_DB:-dsp_test}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PSQL="psql -v ON_ERROR_STOP=1 -q"
if [ "$(id -u)" = "0" ]; then RUN="su postgres -c"; else RUN="bash -c"; fi
$RUN "dropdb --if-exists $DB && createdb $DB"
$RUN "$PSQL -d $DB -f '$ROOT/tests/db/supabase-stub.sql'"
for f in "$ROOT"/supabase/migrations/*.sql; do
  $RUN "$PSQL -d $DB -f '$f'"
done
echo "database $DB ready"
