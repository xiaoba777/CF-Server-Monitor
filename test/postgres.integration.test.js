import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresDatabase } from '../src/database/postgres.js';
import { POSTGRES_SCHEMA_STATEMENTS } from '../src/database/postgresSchema.js';
import { savePostgresJwtSecret, savePostgresThemeOptions } from '../src/database/postgresSettings.js';
import { initDatabase, saveMetricsHistory, getMetricsHistory, getLatestMetrics, getDashboardLatencyHistory, weeklyCleanup, clearHistory } from '../src/database/schema.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { clearAllCaches } from '../src/utils/cache.js';

// Example: CFSM_POSTGRES_TEST_URL=postgres://user:pass@127.0.0.1:5432/test_db
// The test owns only a randomly named schema. Never connect to a production host.
const connectionString = process.env.CFSM_POSTGRES_TEST_URL;

test('PostgreSQL 16 end-to-end schema, settings, history and maintenance', {
  skip: !connectionString && 'Set CFSM_POSTGRES_TEST_URL to an isolated local PostgreSQL 16 database',
  timeout: 60_000
}, async () => {
  const connectionUrl = new URL(connectionString);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(connectionUrl.hostname), 'Integration tests require a loopback host');
  assert.equal(connectionUrl.search, '', 'Use a simple local connection URL without parameter overrides');
  const schemaName = `cfsm_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const administrator = new PostgresDatabase(connectionString);
  const version = await administrator.prepare('SHOW server_version_num').first('server_version_num');
  assert.ok(Number(version) >= 160000, 'PostgreSQL 16 or newer is required');
  await administrator.prepare(`CREATE SCHEMA ${schemaName}`).run();
  connectionUrl.searchParams.set('options', `-c search_path=${schemaName},pg_catalog`);
  const database = new PostgresDatabase(connectionUrl.toString());
  try {
    for (const statement of POSTGRES_SCHEMA_STATEMENTS) await database.prepare(statement).run();
    await initDatabase(database);

    const firstSecret = 'a'.repeat(40);
    assert.equal(await savePostgresJwtSecret(database, firstSecret, 32), firstSecret);
    assert.equal(await savePostgresJwtSecret(database, 'b'.repeat(40), 32), firstSecret);
    for (const malformed of ['not JSON', '[]', 'null', '{"jwt_secret":123}']) {
      await database.prepare("UPDATE settings SET value = ? WHERE key = 'site_options'").bind(malformed).run();
      assert.equal(await savePostgresJwtSecret(database, firstSecret, 32), firstSecret);
    }
    await database.prepare("INSERT INTO settings (key, value) VALUES ('appearance_options', ?)")
      .bind(JSON.stringify({ site_title: 'keep me', theme_options: { old: true } })).run();
    await savePostgresThemeOptions(database, { enabled: false, nested: [1, { value: null }] });
    const appearance = JSON.parse(await database.prepare("SELECT value FROM settings WHERE key = 'appearance_options'").first('value'));
    assert.deepEqual(appearance, { site_title: 'keep me', theme_options: { enabled: false, nested: [1, { value: null }] } });

    const now = Math.floor(Date.now() / 10000) * 10000;
    const server = { id: 'server-a', history_partition_id: 900, timestamp: now - 86400000 };
    await database.prepare('INSERT INTO servers (id, history_partition_id, timestamp) VALUES (?, ?, ?)')
      .bind(server.id, server.history_partition_id, server.timestamp).run();
    const timestamp = now - 600000;
    await saveMetricsHistory(database, server.id, 900, { cpu: 12.1234567890123, loss_ct: false, ping_ct: false }, '', timestamp);
    await saveMetricsHistory(database, server.id, 900, { cpu: 22.1234567890123, loss_ct: 17, ping_ct: 30 }, '', timestamp + 1000);
    // Duplicate reports are harmless; preserve the first complete sample.
    await saveMetricsHistory(database, server.id, 900, { cpu: 99 }, '', timestamp);
    const stored = await database.prepare('SELECT id, timestamp, cpu FROM metrics_history WHERE id = ?')
      .bind(buildHistoryId(900, timestamp)).first();
    assert.equal(stored.id, buildHistoryId(900, timestamp));
    assert.equal(stored.timestamp, timestamp);
    assert.equal(stored.cpu, 12.1234567890123);

    // Include a legacy ID in the imported table; all PG reads are server/time based.
    await database.prepare('INSERT INTO metrics_history_old (id, server_id, timestamp, cpu) VALUES (?, ?, ?, ?)')
      .bind(7, server.id, now - 1200000, 7.1234567890123).run();
    clearAllCaches();
    const shortHistory = await getMetricsHistory(database, server.id, 0.5, 'cpu, loss_ct', server);
    assert.ok(shortHistory.some(row => row.cpu === 7.1234567890123));
    assert.ok(shortHistory.some(row => row.loss_ct === false));
    const longHistory = await getMetricsHistory(database, server.id, 6, 'cpu, loss_ct', server, 120);
    assert.ok(longHistory.length > 0 && longHistory.length <= 120);
    assert.ok(longHistory.every(row => typeof row.timestamp === 'number'));
    const latest = await getLatestMetrics(database, server.id, server);
    assert.equal(latest.timestamp, timestamp + 1000);
    const dashboard = await getDashboardLatencyHistory(database, [server], { now, cache: false });
    assert.ok(dashboard.get(server.id).ping.some(point => point.ct === 30));

    await assert.rejects(database.batch([
      database.prepare("INSERT INTO settings (key, value) VALUES ('must_rollback', 'value')"),
      database.prepare('SELECT missing_column FROM settings')
    ]));
    assert.equal(await database.prepare("SELECT key FROM settings WHERE key = 'must_rollback'").first(), null);

    await database.prepare("INSERT INTO metrics_history (id, server_id, timestamp) VALUES (1, 'server-a', 0)").run();
    assert.equal((await weeklyCleanup(database)).success, true);
    assert.equal(await database.prepare('SELECT id FROM metrics_history WHERE id = 1').first(), null);
    assert.ok(await database.prepare('SELECT id FROM metrics_history_old WHERE id = 7').first());
    assert.equal((await clearHistory(database)).success, true);
    assert.equal(await database.prepare('SELECT count(*) AS count FROM metrics_history').first('count'), 0);
    assert.equal(await database.prepare('SELECT count(*) AS count FROM metrics_history_old').first('count'), 0);
    assert.equal(await database.prepare('SELECT count(*) AS count FROM servers').first('count'), 1);
    await initDatabase(database);
  } finally {
    clearAllCaches();
    await administrator.prepare(`DROP SCHEMA ${schemaName} CASCADE`).run();
  }
});
