# PostgreSQL deployment runbook

## Release status and safety gates

This branch adds a PostgreSQL deployment option. It is not evidence that the
production database has been provisioned, migrated, or cut over. Never delete
D1 as part of an automatic deployment. Keep the previous release and a verified
export until the new deployment and its maintenance tasks have been validated.

The existing `xui` database and role must not be reused by this application.
The existing cluster administrator can still access every database: separate
databases and ordinary roles do not isolate data from a superuser.

## Prerequisites

- Node.js 22.13+ for offline migration tooling; PostgreSQL 16 and psql 16.
- Authenticated Cloudflare and GitHub access, and a confirmed production Worker
  name and hostname. Do not infer the production name from local wrangler.toml.
- A private PostgreSQL connection protected by TLS, Cloudflare Tunnel and an
  Access Service Auth policy, connected to Hyperdrive.
- Explicitly disable Hyperdrive query caching for this configuration. Stale
  authentication, configuration or monitor-state reads are not acceptable.
- Bound origin connection pool sizes below the runtime role's connection limit.
  A shared, memory-constrained instance needs measured limits, not defaults.
- Workers Free currently permits 100,000 Hyperdrive statements per day. Moving
  off D1 removes D1 row quotas, not all Cloudflare quotas. Check current pricing:
  <https://developers.cloudflare.com/hyperdrive/platform/pricing/>.

Private database setup:
<https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/>.
Do not publish port 5432 to the entire Internet. A Tunnel does not remove the
documented database TLS prerequisite. Do not change the shared container's
network or restart it without assessing impact on its existing application.

`scripts/postgres-enable-tls-shared-instance.sh` enables optional PostgreSQL TLS
on the shared instance with a private CA. It reloads configuration and does not
require TLS for existing 3x-ui connections. Hyperdrive cannot use the default
WebPKI `require` mode with this certificate: upload `/root/.cf-server-monitor/tls/ca.crt`
and use `verify-ca`. Reissue the server certificate before `verify-full` if the
Tunnel hostname is not already in the certificate SAN.

## Database and credentials

Review `scripts/postgres-provision.sql` before executing it. It creates only
`cf_server_monitor`, `cf_monitor_migrator` and `cf_monitor_runtime`, with a
dedicated schema and owner-specific default grants. It refuses existing names
instead of adopting or overwriting them. Application migrations run as the
migrator, never as the runtime role or the existing application administrator.

On a shared 1Panel/PostgreSQL 16 host, `scripts/postgres-bootstrap-shared-instance.sh`
can copy those SQL files, create the isolated database/roles, install ordered
pg_hba allow/reject rules, apply the application schema, and verify that the
new roles cannot log in to `xui`. It does not restart PostgreSQL, publish port
5432, enable TLS, or modify the `xui` database. Password files stay on the host
under a root-only directory and must not be committed.

SQL grants alone cannot deny a role access inherited from PUBLIC on other
databases. Install and validate role-specific pg_hba allow/reject rules before
enabling remote use. Do not revoke PUBLIC privileges on existing databases or
change the existing `xui` role as a side effect. Verify both new identities cannot
connect to `xui`, `postgres` or `template1`, using correct credentials so a wrong
password is not mistaken for successful isolation.

Run `scripts/postgres-verify-isolation.sql` using a fresh runtime login after
migration. Also verify TLS certificate validation, backup/restore, and actual
application DML. The catalog checks alone do not prove network isolation.

Credentials belong in a secret manager, protected local environment, or Workers
Secrets; never commit them, dump container environment variables, or put them in
command arguments. Local `.dev.vars`, `.env` and `backups/` are ignored by Git.

## Data migration

1. Export D1 while its account quota permits access. Protect the export: it can
   contain authentication material and notification credentials.
2. Rehearse migration against an isolated target, not the live `xui` database.
3. Stop old-backend writes for the final export/import. Do not assume Agents
   buffer every report; a maintenance window may lose monitoring samples.
4. Use the offline migration tool in dry-run mode first, then explicitly apply
   to an empty target. Never use search/replace to convert a SQLite SQL dump into
   PostgreSQL SQL. Validate schemas, timestamps, disabled-metric sentinels,
   history IDs and all row counts.
5. Verify site settings, server IDs and authentication material in addition to
   history counts. Do not restore raw exports into an already active target.

## CI and configuration

The workflow uses the GitHub `production` environment. Configure its required
reviewers in GitHub: declaring the name in YAML does not create an approval rule.
It builds a generated JSON config rather than injecting secrets into shell code.

Repository/environment variables:

- `WORKER_NAME`: the explicitly confirmed existing Worker.
- `DATABASE_BACKEND`: `d1` for the old backend, `postgres` for Hyperdrive.

Secrets:

- `CF_ACCOUNT_ID`, `CF_API_TOKEN`: deployment credentials with least privilege.
- `API_SECRET`, `API_USER_NAME`, `CORS_ALLOWED_ORIGINS`: existing application
  values; preserve authentication continuity rather than generating replacements.
- `D1_DATABASE_ID`: required for a D1 deployment.
- `HYPERDRIVE_ID`: required for a PostgreSQL deployment. Its origin credentials
  use the runtime role, not the migration owner or superuser.

`API_SECRET` is uploaded as a Workers Secret. Database passwords are not Worker
variables. Hyperdrive supplies its managed connection string through its binding.

Run `npm ci`, `npm run test:all` and `npm run build:frontend`. Generate the config
with `npm run deploy:config`, then use `wrangler deploy --config
wrangler.deploy.json` in the authenticated release process. The ordinary local
`npm run deploy` still targets the local D1 wrangler.toml; do not use it for the
PostgreSQL production release.

Push this branch for review without merging to main until data and infrastructure
are ready. A push to main may trigger the existing production workflow.

## Acceptance, rollback and D1 retirement

- Test login/logout, private versus public views, server CRUD, Agent HTTP and
  WebSocket reporting, history charts, notification state and scheduled cleanup.
- Test a database outage: bounded failures, no fallback writes to D1, and no
  secrets in error responses.
- Measure query latency, origin memory/connections, and Hyperdrive statement
  count. Embedded PostgreSQL tests do not replace PG16/Hyperdrive network tests.
- Keep old D1 untouched during observation. A code rollback after new writes
  requires reconciling those writes; changing a binding alone is not data rollback.
- Before deleting D1, verify a restorable final backup, no remaining consumers,
  a successful maintenance cycle, and the exact database ID. Preserve Durable
  Object namespaces: their SQLite storage is separate from the old D1 database.

This runbook intentionally contains no automatic D1 deletion command.
