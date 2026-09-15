#!/usr/bin/env bash
# Provision cf_server_monitor on the existing shared PostgreSQL 16 instance.
# Run on the database host as root. Does not modify the xui database or role.
set -euo pipefail
set +x
set +v
umask 077

CONTAINER="${POSTGRES_CONTAINER:-3xui_postgres}"
STATE_DIR="${CF_MONITOR_STATE_DIR:-/root/.cf-server-monitor}"
SQL_DIR="${1:-$STATE_DIR/sql}"
HBA_HOST_PATH="${POSTGRES_HBA_PATH:-/opt/3xui-master/pgdata/pg_hba.conf}"
MARKER='CF-Server-Monitor isolated roles'

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run this script as root on the database host.' >&2
  exit 1
fi
if [[ ! -d $SQL_DIR ]]; then
  echo "SQL directory not found: $SQL_DIR" >&2
  exit 1
fi
for required in postgres-provision.sql postgres-schema.sql postgres-verify-isolation.sql postgres-pg-hba-isolation.conf; do
  if [[ ! -f $SQL_DIR/$required ]]; then
    echo "Missing $SQL_DIR/$required" >&2
    exit 1
  fi
done
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" | grep -qx true; then
  echo "Container $CONTAINER is not running." >&2
  exit 1
fi
if [[ ! -f $HBA_HOST_PATH ]]; then
  echo "pg_hba.conf not found at $HBA_HOST_PATH" >&2
  exit 1
fi

install -d -m 700 "$STATE_DIR"
xui_size_before=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc "SELECT pg_database_size('xui')")
xui_connections_before=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = 'xui'")
existing_database=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc "SELECT datname FROM pg_database WHERE datname = 'cf_server_monitor'")
existing_roles=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc "SELECT rolname FROM pg_roles WHERE rolname IN ('cf_monitor_migrator', 'cf_monitor_runtime') ORDER BY 1")
if [[ -n $existing_database || -n $existing_roles ]]; then
  echo 'Refusing to adopt an existing cf_server_monitor database or monitor role.' >&2
  exit 1
fi
if [[ -e $STATE_DIR/migrator.pw || -e $STATE_DIR/runtime.pw || -e $STATE_DIR/provision.env ]]; then
  echo 'Refusing to overwrite existing password files in the state directory.' >&2
  exit 1
fi
if grep -Fq "$MARKER" "$HBA_HOST_PATH"; then
  echo 'pg_hba isolation rules already present; refusing to edit.' >&2
  exit 1
fi

openssl rand -hex 32 > "$STATE_DIR/migrator.pw"
openssl rand -hex 32 > "$STATE_DIR/runtime.pw"
chmod 600 "$STATE_DIR/migrator.pw" "$STATE_DIR/runtime.pw"
printf 'CF_MONITOR_MIGRATOR_PASSWORD=%s\nCF_MONITOR_RUNTIME_PASSWORD=%s\n' \
  "$(cat "$STATE_DIR/migrator.pw")" "$(cat "$STATE_DIR/runtime.pw")" > "$STATE_DIR/provision.env"
chmod 600 "$STATE_DIR/provision.env"

container_address=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}/{{.IPPrefixLen}}{{end}}' "$CONTAINER")
docker_cidr=$(python3 -c 'import ipaddress, sys; print(ipaddress.ip_network(sys.argv[1], strict=False))' "$container_address")
if [[ ! $docker_cidr =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]]; then
  echo 'Could not determine the PostgreSQL container bridge CIDR.' >&2
  exit 1
fi
hba_snippet=$(sed "s|DOCKER_BRIDGE_CIDR|$docker_cidr|g" "$SQL_DIR/postgres-pg-hba-isolation.conf")

docker cp "$SQL_DIR/postgres-provision.sql" "$CONTAINER":/tmp/postgres-provision.sql
docker cp "$SQL_DIR/postgres-schema.sql" "$CONTAINER":/tmp/postgres-schema.sql
docker cp "$SQL_DIR/postgres-verify-isolation.sql" "$CONTAINER":/tmp/postgres-verify-isolation.sql

docker exec --env-file "$STATE_DIR/provision.env" "$CONTAINER" \
  psql -X -U xui -d postgres -v ON_ERROR_STOP=1 -f /tmp/postgres-provision.sql

install -m 600 /dev/null "$STATE_DIR/pgpass"
printf '*:*:*:cf_monitor_migrator:%s\n*:*:*:cf_monitor_runtime:%s\n' \
  "$(cat "$STATE_DIR/migrator.pw")" "$(cat "$STATE_DIR/runtime.pw")" > "$STATE_DIR/pgpass"
docker cp "$STATE_DIR/pgpass" "$CONTAINER":/tmp/cf-monitor.pgpass
docker exec "$CONTAINER" chmod 600 /tmp/cf-monitor.pgpass
rm -f "$STATE_DIR/pgpass"

backup_path="$HBA_HOST_PATH.bak.cf-monitor-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$HBA_HOST_PATH" "$backup_path"
HBA_SNIPPET="$hba_snippet" python3 - "$HBA_HOST_PATH" <<'PY'
from pathlib import Path
import os
import sys
path = Path(sys.argv[1])
snippet = os.environ['HBA_SNIPPET']
if not snippet.endswith('\n'):
    snippet += '\n'
path.write_text(snippet + path.read_text())
PY

reload=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc 'SELECT pg_reload_conf()')
if [[ $reload != t ]]; then
  echo 'pg_reload_conf() did not return true; restoring previous pg_hba.conf.' >&2
  cp -p "$backup_path" "$HBA_HOST_PATH"
  docker exec "$CONTAINER" psql -X -U xui -d postgres -c 'SELECT pg_reload_conf()' >/dev/null
  exit 1
fi

docker exec -e PGPASSFILE=/tmp/cf-monitor.pgpass "$CONTAINER" \
  psql -X -h /var/run/postgresql -U cf_monitor_migrator -d cf_server_monitor -v ON_ERROR_STOP=1 -f /tmp/postgres-schema.sql
docker exec -e PGPASSFILE=/tmp/cf-monitor.pgpass "$CONTAINER" \
  psql -X -h /var/run/postgresql -U cf_monitor_runtime -d cf_server_monitor -v ON_ERROR_STOP=1 -f /tmp/postgres-verify-isolation.sql

set +e
migrator_xui=$(docker exec -e PGPASSFILE=/tmp/cf-monitor.pgpass "$CONTAINER" \
  psql -X -h /var/run/postgresql -U cf_monitor_migrator -d xui -c 'SELECT 1' 2>&1)
migrator_xui_status=$?
runtime_xui=$(docker exec -e PGPASSFILE=/tmp/cf-monitor.pgpass "$CONTAINER" \
  psql -X -h /var/run/postgresql -U cf_monitor_runtime -d xui -c 'SELECT 1' 2>&1)
runtime_xui_status=$?
runtime_ok=$(docker exec -e PGPASSFILE=/tmp/cf-monitor.pgpass "$CONTAINER" \
  psql -X -h /var/run/postgresql -U cf_monitor_runtime -d cf_server_monitor -tAc 'SELECT current_user || chr(32) || current_database()')
runtime_ok_status=$?
xui_ok=$(docker exec "$CONTAINER" psql -X -U xui -d xui -tAc 'SELECT current_user || chr(32) || current_database()')
xui_ok_status=$?
set -e

docker exec "$CONTAINER" rm -f /tmp/postgres-provision.sql /tmp/postgres-schema.sql /tmp/postgres-verify-isolation.sql /tmp/cf-monitor.pgpass
rm -f "$STATE_DIR/provision.env"

xui_size_after=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc "SELECT pg_database_size('xui')")
xui_connections_after=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = 'xui'")
monitor_tables=$(docker exec "$CONTAINER" psql -X -U xui -d cf_server_monitor -tAc "SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cf_server_monitor' AND c.relkind = 'r' ORDER BY 1")

echo "xui_size_before=$xui_size_before"
echo "xui_size_after=$xui_size_after"
echo "xui_connections_before=$xui_connections_before"
echo "xui_connections_after=$xui_connections_after"
echo "xui_login_status=$xui_ok_status xui_login=$xui_ok"
echo "runtime_monitor_login_status=$runtime_ok_status runtime_monitor_login=$runtime_ok"
echo "migrator_xui_rejected=$migrator_xui_status"
echo "runtime_xui_rejected=$runtime_xui_status"
echo "pg_hba_backup=$backup_path"
echo "docker_cidr=$docker_cidr"
echo "monitor_tables:"
echo "$monitor_tables"
echo "password files remain in $STATE_DIR and are not printed."

if [[ $xui_ok_status -ne 0 || $runtime_ok_status -ne 0 || $migrator_xui_status -eq 0 || $runtime_xui_status -eq 0 ]]; then
  echo 'Isolation or 3x-ui connectivity check failed.' >&2
  echo "migrator_xui_output=${migrator_xui//$'\n'/ }" >&2
  echo "runtime_xui_output=${runtime_xui//$'\n'/ }" >&2
  if [[ $xui_ok_status -ne 0 ]]; then
    echo 'Restoring previous pg_hba.conf because the xui role can no longer connect.' >&2
    cp -p "$backup_path" "$HBA_HOST_PATH"
    docker exec "$CONTAINER" psql -X -U xui -d postgres -c 'SELECT pg_reload_conf()' >/dev/null || true
  fi
  exit 1
fi
if [[ $xui_size_after -ne $xui_size_before ]]; then
  echo 'xui database size changed during provisioning; inspect before continuing.' >&2
  exit 1
fi
echo 'Provisioned cf_server_monitor with role isolation. xui was not modified.'
