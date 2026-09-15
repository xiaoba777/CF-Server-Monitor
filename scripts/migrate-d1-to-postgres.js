#!/usr/bin/env node
// Offline migration: never run this against a live application database.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { POSTGRES_SCHEMA_STATEMENTS, POSTGRES_SERVER_COLUMNS } from '../src/database/postgresSchema.js';
import { HISTORY_TABLE_COLUMNS, PROBE_METRIC_FIELDS } from '../src/utils/historyFields.js';

const TABLES = ['settings', 'servers', 'metrics_history', 'metrics_history_old'];
const DEFINITIONS = {
  settings: { key: 'TEXT NOT NULL', value: 'TEXT' },
  servers: POSTGRES_SERVER_COLUMNS,
  metrics_history: Object.fromEntries(HISTORY_TABLE_COLUMNS),
  metrics_history_old: Object.fromEntries(HISTORY_TABLE_COLUMNS)
};
const MAX_SAFE_INTEGER = 9007199254740991n;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;

export class MigrationError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new MigrationError(message);
}

function integer(value, label) {
  requireCondition(typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^-?\d+$/.test(value)), `${label}: expected an exact integer`);
  return BigInt(value);
}

export function normalizeTimestamp(value, { allowZero = false } = {}) {
  let timestamp = integer(value, 'timestamp');
  if (allowZero && timestamp === 0n) return 0n;
  if (timestamp > 0n && timestamp < 10000000000n) timestamp *= 1000n;
  requireCondition(timestamp >= 946684800000n && timestamp < 4102444800000n,
    'timestamp: only seconds or milliseconds in years 2000..2099 are supported');
  return timestamp;
}

export function buildMigratedHistoryId(partitionId, timestamp) {
  const partition = integer(partitionId, 'history_partition_id');
  requireCondition(partition >= 1n && partition <= 900n, 'history_partition_id must be in 1..900');
  const date = new Date(Number(normalizeTimestamp(timestamp)));
  const timeKey = date.toISOString().slice(2, 19).replace(/\D/g, '');
  const historyId = partition * 10000000000000n + BigInt(timeKey);
  requireCondition(historyId <= MAX_SAFE_INTEGER, 'History ID exceeds the application safe-integer limit');
  return historyId;
}

function normalizeCell(value, definition, label, probe = false) {
  if (value === null) {
    requireCondition(!/NOT NULL|PRIMARY KEY/.test(definition), `${label}: NULL is unsupported`);
    return null;
  }
  if (probe && value === 'false') return -1n;
  if (definition.startsWith('TEXT')) {
    requireCondition(typeof value === 'string', `${label}: expected TEXT, not a blob or number`);
    requireCondition(!value.includes('\0'), `${label}: PostgreSQL TEXT cannot contain a NUL character`);
    return value;
  }
  if (/^(INTEGER|BIGINT)/.test(definition)) {
    const result = integer(value, label);
    const maximum = definition.startsWith('INTEGER') && label.startsWith('servers.')
      ? 2147483647n : POSTGRES_BIGINT_MAX;
    requireCondition(result >= -maximum - 1n && result <= maximum, `${label}: integer out of range`);
    return result;
  }
  requireCondition(typeof value === 'number' || typeof value === 'bigint', `${label}: expected a finite number`);
  requireCondition(typeof value !== 'bigint' || (value >= -MAX_SAFE_INTEGER && value <= MAX_SAFE_INTEGER),
    `${label}: integer cannot be represented losslessly as double precision`);
  requireCondition(Number.isFinite(Number(value)), `${label}: expected a finite number`);
  return Number(value);
}

function readRows(database, table) {
  const statement = database.prepare(`SELECT * FROM "${table}"`);
  statement.setReadBigInts(true);
  return statement.all();
}

// Validate and materialize the entire source before opening any PostgreSQL connection.
export function createImportPlan(database) {
  const objects = database.prepare("SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  requireCondition(objects.every(object => object.type === 'index' ||
    (object.type === 'table' && TABLES.includes(object.name))),
  'Unsupported source table, view or trigger. Export only the four supported application tables after reviewing the extra data.');
  const existingTables = new Set(objects.filter(object => object.type === 'table').map(object => object.name));
  requireCondition(existingTables.has('settings') && existingTables.has('servers'), 'Source must contain settings and servers tables');
  const plan = { tables: {}, counts: {}, remappedHistoryIds: 0, assignedPartitions: 0 };
  for (const table of TABLES) {
    if (!existingTables.has(table)) {
      plan.tables[table] = [];
      continue;
    }
    const columns = database.prepare(`PRAGMA table_xinfo("${table}")`).all();
    requireCondition(columns.every(column => Object.hasOwn(DEFINITIONS[table], column.name) && !column.hidden),
      `${table}: unsupported or generated columns; review/upgrade the source without discarding their data`);
    const requiredColumns = table === 'settings' ? ['key', 'value'] : table === 'servers' ? ['id'] : ['id', 'server_id', 'timestamp'];
    requireCondition(requiredColumns.every(name => columns.some(column => column.name === name)), `${table}: missing required columns`);
    plan.tables[table] = readRows(database, table).map(row => Object.fromEntries(Object.entries(row).map(([name, value]) =>
      [name, normalizeCell(value, DEFINITIONS[table][name], `${table}.${name}`, PROBE_METRIC_FIELDS.includes(name))])));
    if (table === 'servers' && !columns.some(column => column.name === 'billing_cycle')) {
      requireCondition(plan.tables[table].every(row => row.price == null || row.price === ''),
        'Legacy combined price configuration is unsupported; upgrade billing fields on a separate source copy first');
    }
  }

  const servers = new Map();
  const partitions = new Set();
  requireCondition(plan.tables.servers.length <= 900, 'At most 900 servers are supported');
  for (const server of plan.tables.servers) {
    requireCondition(server.id !== '' && !servers.has(server.id), 'Duplicate or empty server ID');
    servers.set(server.id, server);
    const partition = server.history_partition_id;
    if (partition != null && partition !== 0n) {
      requireCondition(partition >= 1n && partition <= 900n && !partitions.has(partition),
        'Invalid or duplicate existing history_partition_id; repair the source mapping first');
      partitions.add(partition);
    }
    server.timestamp = normalizeTimestamp(server.timestamp ?? 0n, { allowZero: true });
  }
  for (const server of [...servers.values()].sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)) {
    if (server.history_partition_id == null || server.history_partition_id === 0n) {
      let partition = 1n;
      while (partitions.has(partition)) partition++;
      server.history_partition_id = partition;
      partitions.add(partition);
      plan.assignedPartitions++;
    }
  }
  const settingsKeys = new Set();
  for (const setting of plan.tables.settings) {
    requireCondition(!settingsKeys.has(setting.key), 'Duplicate settings key');
    settingsKeys.add(setting.key);
  }
  for (const table of TABLES.slice(2)) {
    const sourceIds = new Set();
    const destinationIds = new Set();
    for (const row of plan.tables[table]) {
      requireCondition(servers.has(row.server_id), `${table}: orphan history row; restore its server before migration`);
      requireCondition(row.id >= 0n && !sourceIds.has(row.id), `${table}: invalid or duplicate source history ID`);
      sourceIds.add(row.id);
      row.timestamp = normalizeTimestamp(row.timestamp);
      const destinationId = buildMigratedHistoryId(servers.get(row.server_id).history_partition_id, row.timestamp);
      requireCondition(!destinationIds.has(destinationId),
        `${table}: history ID collision (multiple samples for one server in the same second). No rows were discarded; resolve on a separate source copy.`);
      destinationIds.add(destinationId);
      if (row.id !== destinationId) plan.remappedHistoryIds++;
      row.id = destinationId;
    }
  }
  for (const table of TABLES) plan.counts[table] = plan.tables[table].length;
  return plan;
}

export async function loadSource(sourcePath, format, trustedSql = false) {
  requireCondition(['sql', 'sqlite'].includes(format), 'Specify --format sql or --format sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(format === 'sql' ? ':memory:' : resolve(sourcePath), {
    readOnly: format === 'sqlite', allowExtension: false
  });
  try {
    if (format === 'sql') {
      requireCondition(trustedSql, 'SQL execution requires --trusted-sql. Inspect the export first; this is not a SQL sandbox.');
      const sql = await readFile(sourcePath, 'utf8');
      requireCondition(!/\b(ATTACH|DETACH|VACUUM|load_extension|writable_schema)\b/i.test(sql),
        'SQL export contains unsupported filesystem/extension statements (or matching text); use a SQLite snapshot instead');
      database.exec(sql);
    }
    database.exec('PRAGMA query_only = ON; BEGIN');
    const integrity = database.prepare('PRAGMA quick_check').all();
    requireCondition(integrity.length === 1 && Object.values(integrity[0])[0] === 'ok', 'SQLite integrity check failed');
    return createImportPlan(database);
  } finally {
    database.close();
  }
}

export function validateTarget(connectionString, testDatabase) {
  let target;
  try { target = new URL(connectionString); } catch { throw new MigrationError('Invalid MIGRATION_DATABASE_URL'); }
  requireCondition(['postgres:', 'postgresql:'].includes(target.protocol) && !target.search && !target.hash,
    'Use a PostgreSQL URL without query parameters or fragments');
  requireCondition(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Only a local PostgreSQL target is permitted');
  const databaseName = target.pathname.slice(1);
  requireCondition(testDatabase === undefined || /^cf_server_monitor_test_[a-z0-9_]+$/.test(testDatabase),
    'Test database must be explicitly named cf_server_monitor_test_<suffix>');
  requireCondition(databaseName === (testDatabase ?? 'cf_server_monitor'),
    'Target database must be cf_server_monitor or the explicit --test-database name');
  return databaseName;
}

// The caller owns the client. All DDL, locking, inserts and count checks share one transaction.
export async function applyImportPlan(client, plan, databaseName) {
  requireCondition(databaseName === 'cf_server_monitor' || /^cf_server_monitor_test_[a-z0-9_]+$/.test(databaseName), 'Unsafe target database name');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path = cf_server_monitor, pg_catalog");
    // Never mistake rows hidden by row-level security for an empty target.
    await client.query('SET LOCAL row_security = off');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const identity = await client.query("SELECT current_database() AS name, current_user AS user_name, current_schema() AS schema_name, current_setting('server_version_num') AS version");
    requireCondition(identity.rows[0].name === databaseName, 'Connected database does not match the authorized target');
    requireCondition(identity.rows[0].user_name === 'cf_monitor_migrator' && identity.rows[0].schema_name === 'cf_server_monitor',
      'Use cf_monitor_migrator and provision the cf_server_monitor schema first');
    requireCondition(Math.floor(Number(identity.rows[0].version) / 10000) === 16, 'Target must run PostgreSQL 16');
    await client.query("SELECT pg_advisory_xact_lock(617280319)");
    const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'cf_server_monitor'");
    requireCondition(existing.rows.every(row => TABLES.includes(row.tablename)), 'Target contains unsupported application tables; use a dedicated empty database');
    for (const statement of POSTGRES_SCHEMA_STATEMENTS) await client.query(statement);
    await client.query('LOCK TABLE settings, servers, metrics_history, metrics_history_old IN ACCESS EXCLUSIVE MODE');
    const triggers = await client.query("SELECT 1 FROM pg_trigger WHERE tgrelid IN ('settings'::regclass, 'servers'::regclass, 'metrics_history'::regclass, 'metrics_history_old'::regclass) AND NOT tgisinternal");
    requireCondition(triggers.rows.length === 0, 'Target application tables must not have custom triggers');
    const rules = await client.query("SELECT 1 FROM pg_rules WHERE schemaname = 'cf_server_monitor' AND tablename = ANY($1::text[])", [TABLES]);
    requireCondition(rules.rows.length === 0, 'Target application tables must not have custom rules');
    for (const table of TABLES) {
      const shape = await client.query(`SELECT column_name, data_type, is_generated FROM information_schema.columns
        WHERE table_schema = 'cf_server_monitor' AND table_name = $1`, [table]);
      const expectedColumns = Object.entries(DEFINITIONS[table]);
      requireCondition(shape.rows.length === expectedColumns.length && expectedColumns.every(([name, definition]) => {
        const expectedType = definition.startsWith('TEXT') ? 'text'
          : /^(REAL|DOUBLE)/.test(definition) ? 'double precision'
          : definition.startsWith('BIGINT') || table.startsWith('metrics_history') ? 'bigint' : 'integer';
        return shape.rows.some(column => column.column_name === name && column.data_type === expectedType && column.is_generated === 'NEVER');
      }), 'Target table columns/types differ from the migration schema; use an empty database with the supplied schema');
      const count = await client.query(`SELECT COUNT(*) AS count FROM "${table}"`);
      requireCondition(count.rows[0].count === '0', 'All target application tables must be empty; no overwrite is allowed');
    }
    for (const table of TABLES) {
      for (const row of plan.tables[table]) {
        const columns = Object.keys(row);
        requireCondition(columns.every(column => Object.hasOwn(DEFINITIONS[table], column)), 'Invalid import plan column');
        const placeholders = columns.map((_, index) => `$${index + 1}`);
        await client.query(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
          columns.map(column => typeof row[column] === 'bigint' ? row[column].toString() : row[column]));
      }
      const count = await client.query(`SELECT COUNT(*) AS count FROM "${table}"`);
      requireCondition(count.rows[0].count === String(plan.counts[table]), 'Post-import count verification failed');
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* A disconnected client also rolls back on the server. */ }
    throw error;
  }
}

export const USAGE = `Usage (Node >=22.13; PostgreSQL 16):
  node scripts/migrate-d1-to-postgres.js --source backup.sqlite --format sqlite
  node scripts/migrate-d1-to-postgres.js --source export.sql --format sql --trusted-sql
  node scripts/migrate-d1-to-postgres.js --source backup.sqlite --format sqlite --apply
  Test targets additionally require --test-database cf_server_monitor_test_<suffix>.
Default: source validation/dry-run only, with no PostgreSQL connection. Supply MIGRATION_DATABASE_URL via a protected environment, not arguments or shell history.
Apply requires the provisioned cf_server_monitor schema and cf_monitor_migrator login, using localhost or an authenticated SSH port forward.
Stop source/target writers first. Use a consistent SQLite backup (including committed WAL data), not a copied live database file.
SQL must be trusted: it executes in in-memory SQLite, not PostgreSQL. This is not a sandbox.
Only settings, servers, metrics_history and metrics_history_old are accepted. Unknown columns/tables, legacy combined billing data,
orphan rows, fractional integer metrics and same-second history ID collisions are rejected, never dropped.
History IDs are rebuilt from server partition + UTC second; settings values/server IDs are unchanged.
The full source and collision sets must fit in memory. Missing supported columns use target schema defaults.
Dry-run validates the source, not target connectivity/schema. Apply creates schema inside one transaction and requires empty tables.`;

export async function main(argumentsList = process.argv.slice(2), environment = process.env) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    requireCondition(['--source', '--format', '--test-database', '--trusted-sql', '--apply', '--help'].includes(argument), 'Unknown argument; use --help');
    requireCondition(!Object.hasOwn(options, argument), 'Duplicate argument');
    if (['--trusted-sql', '--apply', '--help'].includes(argument)) options[argument] = true;
    else {
      requireCondition(argumentsList[index + 1] && !argumentsList[index + 1].startsWith('--'), 'Missing argument value');
      options[argument] = argumentsList[++index];
    }
  }
  if (options['--help']) { console.log(USAGE); return; }
  requireCondition(options['--source'], 'Specify --source; use --help');
  const databaseName = options['--apply']
    ? validateTarget(environment.MIGRATION_DATABASE_URL, options['--test-database']) : null;
  const plan = await loadSource(options['--source'], options['--format'], options['--trusted-sql']);
  if (options['--apply']) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: environment.MIGRATION_DATABASE_URL, connectionTimeoutMillis: 5000 });
    // Do not print driver errors: PostgreSQL details can contain settings values or credentials.
    client.on('error', () => {});
    try {
      await client.connect();
      await applyImportPlan(client, plan, databaseName);
    } finally {
      await client.end();
    }
  }
  console.log(JSON.stringify({ mode: options['--apply'] ? 'applied' : 'dry-run', counts: plan.counts,
    remappedHistoryIds: plan.remappedHistoryIds, assignedPartitions: plan.assignedPartitions }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof MigrationError ? error.message :
      'Migration failed. No import was committed on validation/insert failure. Check source format, Node version and target availability privately; driver details are suppressed.');
    process.exitCode = 1;
  });
}
