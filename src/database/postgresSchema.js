import { HISTORY_TABLE_COLUMNS, PROBE_METRIC_FIELDS } from '../utils/historyFields.js';

// This schema is for offline provisioning/import, NOT automatic Worker migrations.
// settings.value intentionally stays TEXT: legacy and notification keys contain plain
// strings as well as serialized JSON. Probe columns use -1 for SQLite's 'false' value.
export const POSTGRES_SERVER_COLUMNS = Object.freeze({
  id: 'TEXT PRIMARY KEY', name: 'TEXT', server_group: "TEXT DEFAULT 'Default'",
  region: "TEXT DEFAULT ''", tags: "TEXT DEFAULT ''", note: "TEXT DEFAULT ''",
  price: "TEXT DEFAULT ''", billing_cycle: "TEXT DEFAULT 'month'",
  auto_renewal: "TEXT DEFAULT '0'", currency: "TEXT DEFAULT '\u00a5'",
  expire_date: "TEXT DEFAULT ''", traffic_limit: "TEXT DEFAULT ''",
  traffic_calc_type: "TEXT DEFAULT 'total'", interface: "TEXT DEFAULT ''",
  reset_day: 'INTEGER DEFAULT 1', collect_interval: 'INTEGER DEFAULT 0',
  report_interval: 'INTEGER DEFAULT 60', wss_report_interval: 'INTEGER DEFAULT 2',
  connection_mode: "TEXT DEFAULT 'auto'", ping_mode: "TEXT DEFAULT 'tcp'",
  auto_update: "TEXT DEFAULT '0'", custom_ct: "TEXT DEFAULT ''",
  custom_cu: "TEXT DEFAULT ''", custom_cm: "TEXT DEFAULT ''", custom_bd: "TEXT DEFAULT ''",
  node_1: "TEXT DEFAULT ''", node_2: "TEXT DEFAULT ''", node_3: "TEXT DEFAULT ''", node_4: "TEXT DEFAULT ''",
  rx_correction: 'DOUBLE PRECISION DEFAULT NULL', tx_correction: 'DOUBLE PRECISION DEFAULT NULL',
  offline_notify_disabled: "TEXT DEFAULT '0'", is_hidden: "TEXT DEFAULT '0'",
  sort_order: 'INTEGER DEFAULT 0',
  history_partition_id: 'INTEGER NOT NULL CHECK (history_partition_id BETWEEN 1 AND 900)',
  timestamp: 'BIGINT DEFAULT 0'
});

export function postgresHistoryColumnDefinition(name, definition) {
  if (name === 'id') return 'BIGINT PRIMARY KEY CHECK (id BETWEEN 0 AND 9007199254740991)';
  if (name === 'timestamp') return 'BIGINT NOT NULL DEFAULT 0';
  if (PROBE_METRIC_FIELDS.includes(name)) return 'BIGINT DEFAULT NULL';
  // Translate known schema type tokens, never arbitrary SQL text.
  const [type, ...qualifiers] = definition.split(' ');
  const postgresType = { REAL: 'DOUBLE PRECISION', INTEGER: 'BIGINT', TEXT: 'TEXT' }[type];
  if (!postgresType) throw new Error(`Unsupported history schema type: ${type}`);
  return [postgresType, ...qualifiers].join(' ');
}

export function createPostgresHistoryTableSql(tableName) {
  if (!['metrics_history', 'metrics_history_old'].includes(tableName)) throw new Error('Invalid history table');
  const definitions = HISTORY_TABLE_COLUMNS.map(([name, definition]) =>
    `"${name}" ${postgresHistoryColumnDefinition(name, definition)}`);
  return `CREATE TABLE IF NOT EXISTS ${tableName} (${definitions.join(',\n')})`;
}

export const POSTGRES_SCHEMA_STATEMENTS = Object.freeze([
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
  `CREATE TABLE IF NOT EXISTS servers (${Object.entries(POSTGRES_SERVER_COLUMNS)
    .map(([name, definition]) => `"${name}" ${definition}`).join(',\n')})`,
  'CREATE UNIQUE INDEX IF NOT EXISTS servers_history_partition_unique ON servers (history_partition_id)',
  ...['metrics_history', 'metrics_history_old'].flatMap(tableName => [
    createPostgresHistoryTableSql(tableName),
    `CREATE INDEX IF NOT EXISTS ${tableName}_server_time ON ${tableName} (server_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS ${tableName}_retention_time ON ${tableName} (timestamp)`
  ])
]);

export async function validatePostgresSchema(database) {
  // Cheap, read-only shape checks. A missing migration must fail, not partially repair.
  await database.prepare('SELECT key, value FROM settings LIMIT 0').all();
  await database.prepare(`SELECT ${Object.keys(POSTGRES_SERVER_COLUMNS).map(name => `"${name}"`).join(', ')} FROM servers LIMIT 0`).all();
  for (const tableName of ['metrics_history', 'metrics_history_old']) {
    await database.prepare(`SELECT ${HISTORY_TABLE_COLUMNS.map(([name]) => `"${name}"`).join(', ')} FROM ${tableName} LIMIT 0`).all();
  }
}
