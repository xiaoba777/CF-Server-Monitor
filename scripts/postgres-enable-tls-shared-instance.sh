#!/usr/bin/env bash
# Enable optional TLS on the shared PostgreSQL 16 instance.
# Does not modify the xui database, does not publish port 5432, and does not
# require TLS for existing local/docker clients such as 3x-ui.
set -euo pipefail
set +x
set +v
umask 077

CONTAINER="${POSTGRES_CONTAINER:-3xui_postgres}"
STATE_DIR="${CF_MONITOR_STATE_DIR:-/root/.cf-server-monitor}"
PGDATA_HOST="${POSTGRES_DATA_PATH:-/opt/3xui-master/pgdata}"
CONF_HOST="$PGDATA_HOST/postgresql.conf"
SSL_HOST="$PGDATA_HOST/ssl"
TLS_STATE="$STATE_DIR/tls"
MARKER='# CF-Server-Monitor TLS'
POSTGRES_UID="${POSTGRES_UID:-70}"
POSTGRES_GID="${POSTGRES_GID:-70}"

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run this script as root on the database host.' >&2
  exit 1
fi
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" | grep -qx true; then
  echo "Container $CONTAINER is not running." >&2
  exit 1
fi
if [[ ! -f $CONF_HOST ]]; then
  echo "postgresql.conf not found at $CONF_HOST" >&2
  exit 1
fi
if grep -Fq "$MARKER" "$CONF_HOST"; then
  echo 'TLS configuration marker already present; refusing to edit.' >&2
  exit 1
fi
if [[ -e $SSL_HOST || -e $TLS_STATE ]]; then
  echo 'TLS directories already exist; refusing to overwrite certificates.' >&2
  exit 1
fi

xui_size_before=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc "SELECT pg_database_size('xui')")
xui_login_before=$(docker exec "$CONTAINER" psql -X -U xui -d xui -tAc "SELECT current_user || chr(32) || current_database()")
ssl_before=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc 'SHOW ssl')
if [[ $ssl_before != off ]]; then
  echo "Unexpected current ssl setting: $ssl_before" >&2
  exit 1
fi

install -d -m 700 "$TLS_STATE"
install -d -m 700 -o "$POSTGRES_UID" -g "$POSTGRES_GID" "$SSL_HOST"

openssl req -new -x509 -days 3650 -nodes \
  -newkey rsa:4096 \
  -keyout "$TLS_STATE/ca.key" \
  -out "$TLS_STATE/ca.crt" \
  -subj '/CN=cf-server-monitor-pg-ca' >/dev/null 2>&1

openssl req -new -nodes \
  -newkey rsa:2048 \
  -keyout "$SSL_HOST/server.key" \
  -out "$SSL_HOST/server.csr" \
  -subj '/CN=3xui_postgres' >/dev/null 2>&1

cat > "$SSL_HOST/server.ext" <<'EXT'
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
DNS.2 = 3xui_postgres
DNS.3 = postgres
IP.1 = 127.0.0.1
IP.2 = 172.20.0.2
EXT

openssl x509 -req -days 825 \
  -in "$SSL_HOST/server.csr" \
  -CA "$TLS_STATE/ca.crt" \
  -CAkey "$TLS_STATE/ca.key" \
  -CAcreateserial \
  -out "$SSL_HOST/server.crt" \
  -extfile "$SSL_HOST/server.ext" >/dev/null 2>&1

cp "$TLS_STATE/ca.crt" "$SSL_HOST/ca.crt"
rm -f "$SSL_HOST/server.csr" "$SSL_HOST/server.ext" "$TLS_STATE/ca.srl"
chown -R "$POSTGRES_UID:$POSTGRES_GID" "$SSL_HOST"
chmod 600 "$SSL_HOST/server.key" "$TLS_STATE/ca.key"
chmod 644 "$SSL_HOST/server.crt" "$SSL_HOST/ca.crt" "$TLS_STATE/ca.crt"

backup_path="$CONF_HOST.bak.cf-monitor-tls-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$CONF_HOST" "$backup_path"
cat >> "$CONF_HOST" <<'CONF'

# CF-Server-Monitor TLS
# Optional TLS: existing non-SSL clients such as 3x-ui keep working.
ssl = on
ssl_cert_file = 'ssl/server.crt'
ssl_key_file = 'ssl/server.key'
ssl_ca_file = 'ssl/ca.crt'
ssl_min_protocol_version = 'TLSv1.2'
CONF

reload=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc 'SELECT pg_reload_conf()')
if [[ $reload != t ]]; then
  echo 'pg_reload_conf() failed; restoring postgresql.conf.' >&2
  cp -p "$backup_path" "$CONF_HOST"
  docker exec "$CONTAINER" psql -X -U xui -d postgres -c 'SELECT pg_reload_conf()' >/dev/null || true
  exit 1
fi

ssl_after=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc 'SHOW ssl')
if [[ $ssl_after != on ]]; then
  echo "ssl is still $ssl_after after reload; restoring postgresql.conf." >&2
  cp -p "$backup_path" "$CONF_HOST"
  docker exec "$CONTAINER" psql -X -U xui -d postgres -c 'SELECT pg_reload_conf()' >/dev/null || true
  exit 1
fi

xui_login_after=$(docker exec "$CONTAINER" psql -X -U xui -d xui -tAc "SELECT current_user || chr(32) || current_database()")
xui_size_after=$(docker exec "$CONTAINER" psql -X -U xui -d postgres -tAc "SELECT pg_database_size('xui')")
xui_ssl_local=$(docker exec "$CONTAINER" psql -X -U xui -d xui -tAc "SELECT ssl FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE pid = pg_backend_pid()")

install -m 600 /dev/null "$TLS_STATE/pgpass"
printf '*:*:*:cf_monitor_runtime:%s\n' "$(cat "$STATE_DIR/runtime.pw")" > "$TLS_STATE/pgpass"
docker cp "$TLS_STATE/pgpass" "$CONTAINER":/tmp/cf-monitor-tls.pgpass
docker exec "$CONTAINER" chmod 600 /tmp/cf-monitor-tls.pgpass
rm -f "$TLS_STATE/pgpass"

set +e
tls_login=$(docker exec -e PGPASSFILE=/tmp/cf-monitor-tls.pgpass "$CONTAINER" \
  psql -X "host=127.0.0.1 port=5432 dbname=cf_server_monitor user=cf_monitor_runtime sslmode=verify-full sslrootcert=/var/lib/postgresql/data/ssl/ca.crt" \
  -tAc "SELECT current_user || chr(32) || current_database() || chr(32) || ssl::text FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE pid = pg_backend_pid()")
tls_status=$?
openssl_out=$(echo | openssl s_client -starttls postgres -connect 172.20.0.2:5432 -CAfile "$TLS_STATE/ca.crt" -verify_return_error 2>&1)
openssl_status=$?
set -e
docker exec "$CONTAINER" rm -f /tmp/cf-monitor-tls.pgpass

echo "ssl_before=$ssl_before"
echo "ssl_after=$ssl_after"
echo "xui_login_before=$xui_login_before"
echo "xui_login_after=$xui_login_after"
echo "xui_local_ssl=$xui_ssl_local"
echo "xui_size_before=$xui_size_before"
echo "xui_size_after=$xui_size_after"
echo "tls_verify_full_status=$tls_status tls_verify_full=$tls_login"
echo "openssl_starttls_status=$openssl_status"
echo "$openssl_out" | awk '/verify return|Verify return|subject=|issuer=|Protocol  :|Cipher    :|Verify code/ {print}'
echo "conf_backup=$backup_path"
echo "ca_cert=$TLS_STATE/ca.crt"
echo "server_cert=$SSL_HOST/server.crt"

if [[ $tls_status -ne 0 || $openssl_status -ne 0 || $xui_login_after != 'xui xui' || $xui_size_after -ne $xui_size_before ]]; then
  echo 'TLS enablement verification failed; ssl remains on only if PostgreSQL accepted the reload.' >&2
  exit 1
fi
echo 'Enabled optional PostgreSQL TLS. 3x-ui non-TLS connections were preserved.'
