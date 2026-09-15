import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POSTGRES_SERVER_COLUMNS, postgresHistoryColumnDefinition } from '../src/database/postgresSchema.js';
import { HISTORY_TABLE_COLUMNS } from '../src/utils/historyFields.js';
import { applyImportPlan, buildMigratedHistoryId, createImportPlan, loadSource, main, normalizeTimestamp, validateTarget } from './migrate-d1-to-postgres.js';

const FIXTURE_SQL = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO settings VALUES ('token', 'secret-token'), ('history_id_optimized', 'false');
  CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, history_partition_id INTEGER, timestamp INTEGER);
  INSERT INTO servers VALUES ('server-b', 'Preserved name', 0, 1700000000), ('server-a', 'Other', 7, 0);
  CREATE TABLE metrics_history (id INTEGER PRIMARY KEY, server_id TEXT, timestamp INTEGER, ping_ct INTEGER, cpu REAL);
  INSERT INTO metrics_history VALUES (9223372036854775806, 'server-b', 1700000000, 'false', 5.5);
  CREATE TABLE metrics_history_old (id INTEGER PRIMARY KEY, server_id TEXT, timestamp INTEGER);
  INSERT INTO metrics_history_old VALUES (1, 'server-a', 1699000000000);
`;

function withFixture(callback, extraSql = '') {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(FIXTURE_SQL + extraSql);
    return callback(database);
  } finally {
    database.close();
  }
}

test('timestamp normalization is explicit and never substitutes the current time', () => {
  assert.equal(normalizeTimestamp(1700000000n), 1700000000000n);
  assert.equal(normalizeTimestamp('1700000000123'), 1700000000123n);
  assert.equal(normalizeTimestamp(0, { allowZero: true }), 0n);
  for (const value of [null, undefined, 0, -1, 'false', 1.25, 1700000000000000n, 4102444800000n, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeTimestamp(value));
  }
});

test('history ID matches partition multiplier and UTC time key without floating point', () => {
  assert.equal(buildMigratedHistoryId(900, Date.UTC(2099, 11, 31, 23, 59, 59)), 9000991231235959n);
  assert.equal(buildMigratedHistoryId(1, Date.UTC(2000, 0, 1)), 10000101000000n);
  assert.throws(() => buildMigratedHistoryId(901, 1700000000), /1\.\.900/);
});

test('preserves configuration and both history tables; remaps large legacy IDs exactly', () => {
  withFixture(database => {
    const plan = createImportPlan(database);
    assert.deepEqual(plan.counts, { settings: 2, servers: 2, metrics_history: 1, metrics_history_old: 1 });
    assert.equal(plan.tables.settings[0].value, 'secret-token');
    assert.equal(plan.tables.settings[1].value, 'false');
    assert.equal(plan.tables.servers[0].id, 'server-b');
    assert.equal(plan.tables.servers[0].name, 'Preserved name');
    assert.equal(plan.tables.servers[0].timestamp, 1700000000000n);
    assert.equal(plan.tables.servers[0].history_partition_id, 1n);
    assert.equal(plan.tables.servers[1].history_partition_id, 7n);
    assert.equal(plan.tables.metrics_history[0].ping_ct, -1n);
    assert.equal(plan.tables.metrics_history[0].cpu, 5.5);
    assert.equal(plan.tables.metrics_history[0].id, buildMigratedHistoryId(1, 1700000000));
    assert.equal(plan.remappedHistoryIds, 2);
    assert.equal(plan.assignedPartitions, 1);
    const original = database.prepare('SELECT id FROM metrics_history');
    original.setReadBigInts(true);
    assert.equal(original.get().id, 9223372036854775806n);
  });
});

test('preserves canonical IDs and permits overlap between rotated tables', () => {
  withFixture(database => {
    const canonical = buildMigratedHistoryId(7, 1700000000);
    database.prepare('UPDATE metrics_history SET id = ?, server_id = ?').run(canonical, 'server-a');
    database.prepare('UPDATE metrics_history_old SET id = ?, timestamp = ?').run(canonical, 1700000000n);
    const plan = createImportPlan(database);
    assert.equal(plan.remappedHistoryIds, 0);
  });
});

test('rejects legacy collisions instead of overwriting samples', () => {
  withFixture(database => assert.throws(() => createImportPlan(database), /history ID collision/),
    "INSERT INTO metrics_history VALUES (2, 'server-b', 1700000000999, 10, 1)");
});

for (const [label, sql, expected] of [
  ['unknown table', 'CREATE TABLE extra (secret TEXT)', /Unsupported source table/],
  ['SQLite-like user table', 'CREATE TABLE sqliteXsecrets (secret TEXT)', /Unsupported source table/],
  ['unknown column', 'ALTER TABLE servers ADD COLUMN legacy_config TEXT', /unsupported or generated columns/],
  ['view', 'CREATE VIEW extra AS SELECT * FROM servers', /Unsupported source table/],
  ['orphan', "UPDATE metrics_history SET server_id = 'missing'", /orphan/],
  ['duplicate partition', 'UPDATE servers SET history_partition_id = 7', /duplicate existing/],
  ['invalid partition', 'UPDATE servers SET history_partition_id = 901', /Invalid or duplicate/],
  ['fractional probe', 'UPDATE metrics_history SET ping_ct = 1.5', /exact integer/],
  ['invalid probe', "UPDATE metrics_history SET ping_ct = 'true'", /exact integer/],
  ['invalid time', 'UPDATE metrics_history SET timestamp = 0', /timestamp/],
  ['blob setting', "UPDATE settings SET value = X'1234'", /expected TEXT/],
  ['legacy billing', "ALTER TABLE servers ADD COLUMN price TEXT; UPDATE servers SET price = '$5/month'", /Legacy combined price/]
]) {
  test(`rejects ${label} without printing source data`, () => {
    withFixture(database => assert.throws(() => createImportPlan(database), expected), sql);
  });
}

test('target authorization excludes system databases, remote hosts and implicit test targets', () => {
  assert.equal(validateTarget('postgresql://localhost/cf_server_monitor'), 'cf_server_monitor');
  assert.equal(validateTarget('postgres://localhost/cf_server_monitor_test_unit', 'cf_server_monitor_test_unit'), 'cf_server_monitor_test_unit');
  for (const url of ['postgres://localhost/xui', 'postgres://localhost/postgres', 'postgres://localhost/template0',
    'postgres://localhost/template1', 'postgres://localhost/cf_server_monitor_test_unit',
    'postgres://remote.example/cf_server_monitor', 'postgres://localhost/cf_server_monitor?host=remote',
    'postgres://localhost/%63f_server_monitor']) {
    assert.throws(() => validateTarget(url));
  }
  assert.throws(() => validateTarget('postgres://localhost/xui', 'xui'));
});

function fakeClient({ failInsert = false, nonempty = false, wrongCount = false, wrongDatabase = false, wrongShape = false, wrongRole = false, wrongSchema = false } = {}) {
  const calls = [];
  const counts = Object.fromEntries(['settings', 'servers', 'metrics_history', 'metrics_history_old'].map(table => [table, 0]));
  return {
    calls,
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes('current_database()')) return { rows: [{
        name: wrongDatabase ? 'xui' : 'cf_server_monitor', version: '160004',
        user_name: wrongRole ? 'xui' : 'cf_monitor_migrator',
        schema_name: wrongSchema ? 'public' : 'cf_server_monitor'
      }] };
      if (sql.includes('information_schema.columns')) {
        const definitions = parameters[0] === 'settings' ? [['key', 'TEXT'], ['value', 'TEXT']]
          : parameters[0] === 'servers' ? Object.entries(POSTGRES_SERVER_COLUMNS)
          : HISTORY_TABLE_COLUMNS.map(([name, definition]) => [name, postgresHistoryColumnDefinition(name, definition)]);
        return { rows: wrongShape ? [] : definitions.map(([name, definition]) => ({
          column_name: name,
          data_type: definition.startsWith('DOUBLE PRECISION') ? 'double precision' : definition.split(' ')[0].toLowerCase(),
          is_generated: 'NEVER'
        })) };
      }
      if (sql.startsWith('SELECT COUNT')) {
        const table = sql.match(/FROM "([a-z_]+)"/)[1];
        return { rows: [{ count: String(nonempty ? 1 : counts[table] + (wrongCount && counts[table] > 0 ? 1 : 0)) }] };
      }
      if (sql.startsWith('INSERT')) {
        if (failInsert) throw new Error('Simulated insert failure');
        counts[sql.match(/INTO "([a-z_]+)"/)[1]]++;
      }
      return { rows: [] };
    }
  };
}

test('transaction inserts parameterized values, verifies counts and commits', async () => {
  const plan = withFixture(createImportPlan);
  const client = fakeClient();
  await applyImportPlan(client, plan, 'cf_server_monitor');
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
  assert.ok(client.calls.some(call => call.sql.includes('ACCESS EXCLUSIVE')));
  assert.ok(client.calls.some(call => call.parameters?.includes('secret-token')));
  assert.ok(client.calls.every(call => !call.sql.includes('secret-token')));
  assert.ok(client.calls.filter(call => call.sql.startsWith('INSERT')).every(call => /\$1/.test(call.sql)));
});

for (const option of ['failInsert', 'nonempty', 'wrongCount', 'wrongDatabase', 'wrongShape', 'wrongRole', 'wrongSchema']) {
  test(`rolls back on ${option}`, async () => {
    const client = fakeClient({ [option]: true });
    await assert.rejects(applyImportPlan(client, withFixture(createImportPlan), 'cf_server_monitor'));
    assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(client.calls.every(call => call.sql !== 'COMMIT'));
    if (option === 'nonempty' || option === 'wrongDatabase') assert.ok(client.calls.every(call => !call.sql.startsWith('INSERT')));
  });
}

test('loads trusted SQL and read-only SQLite without modifying source; dry-run needs no target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf-monitor-migration-'));
  const originalLog = console.log;
  try {
    const sqlPath = join(directory, 'export.sql');
    const sqlitePath = join(directory, 'backup.sqlite');
    await writeFile(sqlPath, FIXTURE_SQL);
    const database = new DatabaseSync(sqlitePath);
    database.exec(FIXTURE_SQL);
    database.close();
    const before = await readFile(sqlitePath);
    const sqlPlan = await loadSource(sqlPath, 'sql', true);
    assert.deepEqual(await loadSource(sqlitePath, 'sqlite'), sqlPlan);
    assert.deepEqual(await readFile(sqlitePath), before);
    await assert.rejects(loadSource(sqlPath, 'sql'), /trusted-sql/);
    const output = [];
    console.log = message => output.push(message);
    await main(['--source', sqlitePath, '--format', 'sqlite'], {});
    assert.equal(JSON.parse(output[0]).mode, 'dry-run');
    assert.ok(!output[0].includes('secret-token'));
    await assert.rejects(main(['--source', sqlitePath, '--format', 'sqlite', '--apply'], {}), /DATABASE_URL/);
    await assert.rejects(main(['--apply', '--apply'], {}), /Duplicate argument/);
    await assert.rejects(main(['--source'], {}), /Missing argument/);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});
