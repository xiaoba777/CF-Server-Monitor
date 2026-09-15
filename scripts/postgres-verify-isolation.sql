-- READ-ONLY catalog/session checks. Run with psql 16+, -X, ON A FRESH REAL
-- cf_monitor_runtime login to cf_server_monitor, preferably after migrations:
--   psql -X -U cf_monitor_runtime -d cf_server_monitor -f scripts/postgres-verify-isolation.sql
-- Specify intended host/port; use peer auth, a password prompt or a protected
-- PGPASSFILE. Never put credentials in command arguments, URLs or this file.
-- Do not SET ROLE from an administrator: that cannot test login-time settings.
-- No application objects are created, modified, or queried for row contents.
-- Passing these checks does NOT prove pg_hba or cross-database isolation.
--
-- REQUIRED separate connection tests for BOTH cf_monitor_runtime and
-- cf_monitor_migrator, from every permitted client/network/transport:
--   psql -X -U cf_monitor_migrator -d cf_server_monitor -c 'SELECT current_user, current_database()'
--   psql -X -U cf_monitor_runtime  -d cf_server_monitor -c 'SELECT current_user, current_database()'
-- Both must succeed using valid credentials. Then, with the SAME valid identity:
--   psql -X -U cf_monitor_runtime  -d xui       -c 'SELECT 1'
--   psql -X -U cf_monitor_runtime  -d postgres  -c 'SELECT 1'
--   psql -X -U cf_monitor_runtime  -d template1 -c 'SELECT 1'
-- Repeat these rejection tests as cf_monitor_migrator and for every other DB.
-- Each must fail specifically due to the intended pg_hba rejection, not a bad
-- password, missing database, unreachable server, or unrelated authentication
-- error. Also test local sockets, IPv4, IPv6, TLS/non-TLS as reachable.
-- Use connection timeouts in the client environment for manual network tests.
-- An administrator must separately inspect ordered pg_hba_file_rules, check for
-- parse errors, and confirm an approved reload actually activated the rules.
-- Required rule order: allow THIS database for these roles, then reject ALL
-- other databases for them, before existing broad allow rules. See provisioning.
--
-- PUBLIC CONNECT on existing DBs is deliberately NOT revoked. The final report
-- can therefore show SQL CONNECT=true for xui; pg_hba must block the connection.
-- The existing xui role may be superuser: nothing here isolates this database
-- from a cluster superuser, nor changes that role or its existing privileges.
-- Read-only checks cannot prove successful DML under application RLS, triggers,
-- constraints or function dependencies; run application smoke tests separately.
-- Any startup/scheduled CREATE/ALTER/DROP (e.g. history tables) is incompatible
-- with this runtime role and must execute separately as the migrator.

\set ON_ERROR_STOP on
\pset pager off

BEGIN READ ONLY;

DO $$
DECLARE
    migrator_identifier oid;
    runtime_identifier oid;
    schema_identifier oid;
BEGIN
    IF current_database() <> 'cf_server_monitor'
       OR current_user <> 'cf_monitor_runtime'
       OR session_user <> 'cf_monitor_runtime' THEN
        RAISE EXCEPTION 'Use a fresh cf_monitor_runtime login to cf_server_monitor';
    END IF;

    SELECT oid INTO STRICT migrator_identifier FROM pg_roles WHERE rolname = 'cf_monitor_migrator';
    SELECT oid INTO STRICT runtime_identifier FROM pg_roles WHERE rolname = 'cf_monitor_runtime';
    SELECT oid INTO STRICT schema_identifier FROM pg_namespace WHERE nspname = 'cf_server_monitor';

    IF EXISTS (
        SELECT FROM pg_roles
        WHERE oid IN (migrator_identifier, runtime_identifier)
          AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
               OR rolbypassrls OR rolinherit OR NOT rolcanlogin)
    ) OR EXISTS (
        SELECT FROM pg_auth_members
        WHERE member IN (migrator_identifier, runtime_identifier)
           OR roleid IN (migrator_identifier, runtime_identifier)
    ) THEN
        RAISE EXCEPTION 'Unexpected role capabilities or memberships';
    END IF;

    IF (SELECT datdba FROM pg_database WHERE datname = current_database()) <> migrator_identifier
       OR (SELECT nspowner FROM pg_namespace WHERE oid = schema_identifier) <> migrator_identifier THEN
        RAISE EXCEPTION 'Database and application schema must be owned by the migrator';
    END IF;

    IF NOT has_database_privilege(current_user, current_database(), 'CONNECT')
       OR has_database_privilege(current_user, current_database(), 'CREATE')
       OR has_database_privilege(current_user, current_database(), 'TEMP')
       OR NOT has_schema_privilege(current_user, schema_identifier, 'USAGE')
       OR has_schema_privilege(current_user, 'public', 'USAGE')
       OR EXISTS (SELECT FROM pg_namespace WHERE has_schema_privilege(current_user, oid, 'CREATE')) THEN
        RAISE EXCEPTION 'Runtime database/schema privileges do not match DML-only policy';
    END IF;

    IF EXISTS (
        SELECT FROM pg_database AS database_entry,
            LATERAL aclexplode(coalesce(database_entry.datacl, acldefault('d', database_entry.datdba))) AS permission
        WHERE database_entry.datname = current_database() AND permission.grantee = 0
    ) OR EXISTS (
        SELECT FROM pg_namespace AS schema_entry,
            LATERAL aclexplode(coalesce(schema_entry.nspacl, acldefault('n', schema_entry.nspowner))) AS permission
        WHERE schema_entry.nspname IN ('public', 'cf_server_monitor') AND permission.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC has unexpected database/schema privileges';
    END IF;

    IF (SELECT rolconnlimit FROM pg_roles WHERE oid = runtime_identifier) <> 20
       OR (SELECT rolconnlimit FROM pg_roles WHERE oid = migrator_identifier) <> 3
       OR current_setting('search_path') <> 'cf_server_monitor, pg_catalog'
       OR current_setting('statement_timeout') <> '30s'
       OR current_setting('lock_timeout') <> '5s'
       OR current_setting('idle_in_transaction_session_timeout') <> '1min' THEN
        RAISE EXCEPTION 'Unexpected connection limits or runtime session defaults';
    END IF;

    -- Verify future-object grants without creating disposable tables.
    IF EXISTS (
        SELECT FROM (VALUES
            ('r', 'SELECT'), ('r', 'INSERT'), ('r', 'UPDATE'), ('r', 'DELETE'),
            ('S', 'USAGE'), ('S', 'SELECT'), ('T', 'USAGE')
        ) AS expected(object_type, privilege_name)
        WHERE NOT EXISTS (
            SELECT FROM pg_default_acl AS defaults,
                LATERAL aclexplode(defaults.defaclacl) AS permission
            WHERE defaults.defaclrole = migrator_identifier
              AND defaults.defaclnamespace = schema_identifier
              AND defaults.defaclobjtype::text = expected.object_type
              AND permission.grantee = runtime_identifier
              AND permission.privilege_type = expected.privilege_name
              AND NOT permission.is_grantable
        )
    ) THEN
        RAISE EXCEPTION 'Missing migrator-owned future table/sequence/type runtime grants';
    END IF;

    IF EXISTS (
        SELECT FROM (VALUES ('f'::"char"), ('T'::"char")) AS expected(object_type),
            LATERAL aclexplode(coalesce(
                (SELECT defaclacl FROM pg_default_acl
                 WHERE defaclrole = migrator_identifier AND defaclnamespace = 0
                   AND defaclobjtype = expected.object_type),
                acldefault(expected.object_type, migrator_identifier)
            )) AS permission
        WHERE permission.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC future function/type privileges were not revoked';
    END IF;

    IF EXISTS (
        SELECT FROM pg_class AS relation_entry
        WHERE relation_entry.relnamespace = schema_identifier
          AND relation_entry.relkind IN ('r', 'p', 'v', 'f', 'S')
          AND (relation_entry.relowner <> migrator_identifier
               OR CASE WHEN relation_entry.relkind = 'S' THEN
                    NOT has_sequence_privilege(current_user, relation_entry.oid, 'USAGE')
                    OR NOT has_sequence_privilege(current_user, relation_entry.oid, 'SELECT')
                    OR has_sequence_privilege(current_user, relation_entry.oid, 'UPDATE')
                  ELSE
                    NOT has_table_privilege(current_user, relation_entry.oid, 'SELECT')
                    OR NOT has_table_privilege(current_user, relation_entry.oid, 'INSERT')
                    OR NOT has_table_privilege(current_user, relation_entry.oid, 'UPDATE')
                    OR NOT has_table_privilege(current_user, relation_entry.oid, 'DELETE')
                    OR has_table_privilege(current_user, relation_entry.oid, 'TRUNCATE,REFERENCES,TRIGGER')
                  END)
    ) THEN
        RAISE EXCEPTION 'Existing application objects have unexpected ownership or runtime privileges';
    END IF;

    IF NOT EXISTS (SELECT FROM pg_class WHERE relnamespace = schema_identifier AND relkind IN ('r', 'p')) THEN
        RAISE WARNING 'No application tables yet: existing-table checks are vacuous; rerun after migrations';
    END IF;
END
$$;

-- Metadata only. TRUE on other databases means SQL would permit CONNECT;
-- it says nothing about pg_hba, network reachability, or successful login.
SELECT role_entry.rolname AS login_role,
       database_entry.datname AS database_name,
       database_entry.datallowconn AS database_accepts_connections,
       has_database_privilege(role_entry.oid, database_entry.oid, 'CONNECT') AS sql_connect_allowed
FROM pg_roles AS role_entry
CROSS JOIN pg_database AS database_entry
WHERE role_entry.rolname IN ('cf_monitor_migrator', 'cf_monitor_runtime')
ORDER BY role_entry.rolname, database_entry.datname;

SELECT rolname, rolsuper AS is_cluster_superuser
FROM pg_roles WHERE rolname = 'xui';

COMMIT;
\echo 'Catalog/session checks passed. Cross-database isolation still requires the separate pg_hba connection tests.'
