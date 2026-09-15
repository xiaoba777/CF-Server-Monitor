-- Manual provisioning for PostgreSQL 16 / psql 16+. NOT application DDL.
-- Run against the existing cluster's postgres maintenance database as a trusted
-- superuser, with -X (ignore psqlrc) and -f this file. Do not use --single-transaction.
-- Authenticate the administrator using peer auth or a protected PGPASSFILE;
-- never put credentials in a URI, command-line -v argument, or this file.
-- Supply distinct passwords through a trusted psql session's variables
-- cf_monitor_migrator_password / cf_monitor_runtime_password, or export
-- CF_MONITOR_MIGRATOR_PASSWORD / CF_MONITOR_RUNTIME_PASSWORD after hidden prompts.
-- Environment variables are not a secret vault: protect the invoking process,
-- unset them afterwards, and disable shell tracing and terminal/session capture.
-- Review server/audit/proxy statement logging before execution: generated role
-- statements contain passwords. ECHO=none does not protect external logging.
-- Example (password environment already populated securely):
--   psql -X --dbname=postgres --file=scripts/postgres-provision.sql
-- Use explicit non-secret host/port/user options for the intended cluster.
--
-- CRITICAL: SQL privileges alone do NOT provide cross-database role isolation.
-- Before exposing these logins, an operator must install ordered pg_hba rules
-- for BOTH new roles: allow cf_server_monitor from intended sources, THEN reject
-- every other database for those roles, BEFORE any existing broad allow rules.
-- Apply this to every reachable transport/address family (local, IPv4, IPv6).
-- Illustrative rules only; substitute approved CIDRs and authentication policy:
--   local cf_server_monitor cf_monitor_migrator,cf_monitor_runtime scram-sha-256
--   local all cf_monitor_migrator,cf_monitor_runtime reject
--   hostssl cf_server_monitor cf_monitor_migrator,cf_monitor_runtime <APP_CIDR> scram-sha-256
--   host all cf_monitor_migrator,cf_monitor_runtime 0.0.0.0/0 reject
--   host all cf_monitor_migrator,cf_monitor_runtime ::/0 reject
-- Add an IPv6 allow rule before rejects if required. The host rejects also block
-- non-TLS connections. Validate rules and reload as a separate approved operation.
-- Existing xui/PUBLIC grants are deliberately untouched: PUBLIC CONNECT on xui
-- (or postgres/template1/another DB) can otherwise admit these new roles.
-- A superuser xui can still access this database; pg_hba/database ACLs are not a
-- security boundary against a cluster superuser or the PostgreSQL OS owner.
--
-- Fresh identities only: reruns reject any existing DB/role, never adopt or rotate
-- them. CREATE DATABASE cannot be transactional. On failure, some new objects
-- may remain, but logins stay disabled until the LAST transaction commits.
-- Inspect partial state manually; do not blindly drop identities to rerun.
-- Run no concurrent provisioning/DDL against these identities during this file.
-- There is an unavoidable CREATE DATABASE -> REVOKE window for existing cluster
-- users; use an operator-controlled maintenance window / connection restrictions.
-- This file never alters xui, other roles, pg_hba.conf, or application tables.
--
-- Run all application migrations as cf_monitor_migrator with this search_path.
-- Runtime has DML only: startup/scheduled CREATE/ALTER/DROP (including history
-- table creation/pruning) must move to a migrator job, NOT gain runtime DDL rights.
-- Migrations must not override these ACLs or create objects under another owner.
-- Migration tools hardcoding public must be configured for cf_server_monitor.

\set ON_ERROR_STOP on
\set ECHO none
\set QUIET on

DO $$
BEGIN
    IF current_database() <> 'postgres' THEN
        RAISE EXCEPTION 'Connect to the postgres maintenance database';
    END IF;
    IF current_setting('server_version_num')::integer < 160000
       OR current_setting('server_version_num')::integer >= 170000 THEN
        RAISE EXCEPTION 'This provisioning script targets PostgreSQL 16';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
        RAISE EXCEPTION 'Provisioning requires a trusted cluster superuser';
    END IF;
END
$$;

\if :{?cf_monitor_migrator_password}
\else
    \getenv cf_monitor_migrator_password CF_MONITOR_MIGRATOR_PASSWORD
\endif
\if :{?cf_monitor_runtime_password}
\else
    \getenv cf_monitor_runtime_password CF_MONITOR_RUNTIME_PASSWORD
\endif
\if :{?cf_monitor_migrator_password}
\else
    DO $$ BEGIN RAISE EXCEPTION 'Missing migrator password variable'; END $$;
\endif
\if :{?cf_monitor_runtime_password}
\else
    DO $$ BEGIN RAISE EXCEPTION 'Missing runtime password variable'; END $$;
\endif

-- Use quoted psql literals, never interpolate a password as raw SQL.
SELECT length(:'cf_monitor_migrator_password') > 0
   AND length(:'cf_monitor_runtime_password') > 0
   AND :'cf_monitor_migrator_password' <> :'cf_monitor_runtime_password'
   AS passwords_valid \gset
\if :passwords_valid
\else
    DO $$ BEGIN RAISE EXCEPTION 'Passwords must be nonempty and distinct'; END $$;
\endif

BEGIN;
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_database WHERE datname = 'cf_server_monitor')
       OR EXISTS (SELECT FROM pg_roles WHERE rolname IN
                  ('cf_monitor_migrator', 'cf_monitor_runtime')) THEN
        RAISE EXCEPTION 'Target database or role already exists; refusing to adopt or modify it';
    END IF;
END
$$;
SET LOCAL password_encryption = 'scram-sha-256';
CREATE ROLE cf_monitor_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
CREATE ROLE cf_monitor_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;
ALTER ROLE cf_monitor_migrator PASSWORD :'cf_monitor_migrator_password';
ALTER ROLE cf_monitor_runtime PASSWORD :'cf_monitor_runtime_password';
COMMIT;
\unset cf_monitor_migrator_password
\unset cf_monitor_runtime_password

CREATE DATABASE cf_server_monitor OWNER cf_monitor_migrator
    TEMPLATE template0 ENCODING 'UTF8';

-- Only the NEW database's PUBLIC privileges are changed.
BEGIN;
REVOKE ALL ON DATABASE cf_server_monitor FROM PUBLIC;
GRANT CONNECT ON DATABASE cf_server_monitor TO cf_monitor_runtime;
COMMIT;

\connect cf_server_monitor

BEGIN;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM cf_monitor_runtime;
CREATE SCHEMA cf_server_monitor AUTHORIZATION cf_monitor_migrator;
REVOKE ALL ON SCHEMA cf_server_monitor FROM PUBLIC;
GRANT USAGE ON SCHEMA cf_server_monitor TO cf_monitor_runtime;

-- Owner-specific defaults apply only to objects created as the migrator.
-- PUBLIC function/type defaults are global within this NEW database because a
-- per-schema REVOKE cannot cancel PostgreSQL's global default grants.
ALTER DEFAULT PRIVILEGES FOR ROLE cf_monitor_migrator
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE cf_monitor_migrator
    REVOKE USAGE ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE cf_monitor_migrator IN SCHEMA cf_server_monitor
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cf_monitor_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE cf_monitor_migrator IN SCHEMA cf_server_monitor
    GRANT USAGE, SELECT ON SEQUENCES TO cf_monitor_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE cf_monitor_migrator IN SCHEMA cf_server_monitor
    GRANT USAGE ON TYPES TO cf_monitor_runtime;
-- No blanket function EXECUTE grant: review and grant individual routines in
-- migrations, especially SECURITY DEFINER routines. No TRUNCATE/REFERENCES/TRIGGER.

ALTER ROLE cf_monitor_migrator IN DATABASE cf_server_monitor
    SET search_path = cf_server_monitor, pg_catalog;
ALTER ROLE cf_monitor_runtime IN DATABASE cf_server_monitor
    SET search_path = cf_server_monitor, pg_catalog;
ALTER ROLE cf_monitor_runtime SET statement_timeout = '30s';
ALTER ROLE cf_monitor_runtime SET lock_timeout = '5s';
ALTER ROLE cf_monitor_runtime SET idle_in_transaction_session_timeout = '60s';
-- Timeouts are defaults, not tamper-proof limits; users can SET these themselves.
-- Tune pool sizes to stay below the role-wide connection limit across instances.
ALTER ROLE cf_monitor_migrator LOGIN;
ALTER ROLE cf_monitor_runtime LOGIN;
COMMIT;

\echo 'Provisioned. Validate pg_hba isolation using fresh connections before application use.'
\echo 'Run migrations as cf_monitor_migrator, then run postgres-verify-isolation.sql as runtime.'
