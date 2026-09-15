import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresDatabase, compileParameters, parseSafeInteger, withDatabase } from '../src/database/postgres.js';
import { buildHistoryId, HISTORY_MAX_PARTITION_ID } from '../src/database/indexOptimization.js';
import { buildPostgresSparseHistoryQuery } from '../src/database/historySampling.js';
import { updateDatabase, addHistoryColumns } from '../src/database/updateDatabase.js';
import { initDatabase, saveMetricsHistory, weeklyCleanup } from '../src/database/schema.js';
import { HISTORY_INSERT_COLUMNS } from '../src/utils/historyFields.js';
import { normalizeProbeMetricRow } from '../src/utils/metrics.js';
import worker, { MetricsBroadcaster } from '../src/index.js';

function createRecordingDatabase({ failQuery = () => false, rows = [] } = {}) {
  const events = [];
  let connectionCount = 0;
  const database = new PostgresDatabase('local-test-only', async () => {
    const connection = ++connectionCount;
    return {
      async connect() { events.push({ connection, type: 'connect' }); },
      async end() { events.push({ connection, type: 'end' }); },
      async query(query) {
        const text = typeof query === 'string' ? query : query.text;
        events.push({ connection, type: 'query', text, values: query.values });
        if (failQuery(text)) throw new Error('deliberate SQL failure');
        return { rows, rowCount: rows.length };
      }
    };
  });
  return { database, events };
}

test('binding selection is explicit, does not mutate env, and fails closed on misconfiguration', () => {
  const original = { DB: { marker: 'D1' } };
  assert.equal(withDatabase(original), original);
  const configured = { ...original, HYPERDRIVE: { connectionString: 'postgres://local' } };
  assert.equal(withDatabase(configured).DB.dialect, 'postgres');
  assert.equal(configured.DB, original.DB);
  assert.throws(() => withDatabase({ ...original, HYPERDRIVE: {} }), /connectionString/);
});

test('fetch, scheduled and Durable Object entrypoints all select the configured backend', async () => {
  await assert.rejects(worker.fetch(new Request('https://example.test/'), { HYPERDRIVE: {} }, {}), /connectionString/);
  await assert.rejects(worker.scheduled({ cron: 'unused' }, { HYPERDRIVE: {} }, {}), /connectionString/);
  const originalResponsePair = globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair = class {};
  try {
    const env = { DB: { marker: 'D1' }, HYPERDRIVE: { connectionString: 'postgres://local' } };
    const broadcaster = new MetricsBroadcaster({ setWebSocketAutoResponse() {} }, env);
    assert.equal(broadcaster.env.DB.dialect, 'postgres');
    assert.equal(broadcaster.env.DB.transactionClient, null);
    assert.equal(env.DB.marker, 'D1');
  } finally {
    globalThis.WebSocketRequestResponsePair = originalResponsePair;
  }
});

test('parameter markers do not alter quoted SQL, comments or data', () => {
  const sql = `SELECT '?', "?", 'it''s ?', $$?$$, $tag$?$tag$, ?::bigint /* ? /* ? */ */ -- ?\n, ?`;
  const value = "'); DROP TABLE servers; -- ?";
  const query = compileParameters(sql, [9000991231235959, value]);
  assert.equal(query.text, sql.replace('?::bigint', '$1::bigint').replace('\n, ?', '\n, $2'));
  assert.deepEqual(query.values, [9000991231235959, value]);
  assert.throws(() => compileParameters('SELECT ?', []), /count/);
  assert.throws(() => compileParameters("SELECT 'broken", []), /Unterminated/);
  assert.throws(() => compileParameters('SELECT ?', [Number.MAX_SAFE_INTEGER + 1]), /Unsafe/);
});

test('maximum partition history IDs and millisecond timestamps remain exact', () => {
  const timestamp = Date.UTC(2099, 11, 31, 23, 59, 59);
  const historyId = buildHistoryId(HISTORY_MAX_PARTITION_ID, timestamp);
  assert.equal(historyId, 9000991231235959);
  assert.equal(parseSafeInteger(String(historyId)), historyId);
  assert.equal(parseSafeInteger(String(timestamp)), timestamp);
  assert.throws(() => parseSafeInteger('9007199254740993'), /safe range/);
});

test('statements preserve D1 result contracts without retaining clients between calls', async () => {
  const { database, events } = createRecordingDatabase({ rows: [{ id: 42, sample_json: { cpu: 1 } }] });
  const statement = database.prepare('SELECT ? AS id');
  assert.equal(await statement.bind(42).first('id'), 42);
  assert.deepEqual((await statement.bind(43).all()).results[0].sample_json, { cpu: 1 });
  assert.equal((await statement.bind(44).run()).meta.changes, 1);
  assert.equal(events.filter(event => event.type === 'connect').length, 3);
  assert.equal(events.filter(event => event.type === 'end').length, 3);
  assert.deepEqual(events.filter(event => event.values).map(event => event.values), [[42], [43], [44]]);
});

test('batch uses one transaction and rolls back and closes on a failed statement', async () => {
  const { database, events } = createRecordingDatabase({ failQuery: text => text.includes('failure') });
  await assert.rejects(database.batch([
    database.prepare('DELETE FROM settings WHERE key = ?').bind('first'),
    database.prepare('SELECT failure')
  ]), /deliberate/);
  assert.equal(events.filter(event => event.type === 'connect').length, 1);
  assert.equal(events.filter(event => event.type === 'end').length, 1);
  assert.ok(events.some(event => event.text === 'ROLLBACK'));
  assert.ok(!events.some(event => event.text === 'COMMIT'));
});

test('client cleanup also occurs when connect itself fails', async () => {
  let closed = false;
  const database = new PostgresDatabase('local', async () => ({
    async connect() { throw new Error('connect failed'); },
    async end() { closed = true; }
  }));
  await assert.rejects(database.prepare('SELECT 1').first(), /connect failed/);
  assert.equal(closed, true);
});

test('sparse PostgreSQL buckets cross calendar boundaries without date conversions or ID assumptions', () => {
  const start = Date.UTC(2026, 11, 31, 23, 59, 59);
  const query = buildPostgresSparseHistoryQuery({
    columns: 'cpu, loss_ct', serverId: 'server-a', queryStart: start,
    firstRangeEnd: start + 1000, queryEnd: start + 3000, intervalMs: 1000,
    oldTableExists: true, sampleOrder: 'DESC'
  });
  const compiled = compileParameters(query.sql, query.bindValues);
  assert.deepEqual(query.bindValues, [start, start + 1000, start + 1000, start + 2000, start + 2000, start + 3000, 'server-a', 'server-a']);
  assert.match(compiled.text, /timestamp >= ranges.range_start AND timestamp < ranges.range_end/);
  assert.match(compiled.text, /metrics_history_old/);
  assert.match(compiled.text, /row_to_json/);
  assert.doesNotMatch(compiled.text, /strftime|CAST\(.+ AS INTEGER\)|id >=/);
  assert.throws(() => buildPostgresSparseHistoryQuery({ columns: 'cpu); DROP TABLE servers' }), /Invalid history columns/);
});

test('PostgreSQL init validates only and runtime upgrades never rewrite schema', async () => {
  const { database, events } = createRecordingDatabase();
  await initDatabase(database);
  assert.equal((await updateDatabase(database)).success, false);
  await assert.rejects(addHistoryColumns(database), /offline migration/);
  assert.ok(events.filter(event => event.text).every(event => /^SELECT /s.test(event.text)));
});

test('history writes retain precision, encode disabled probes and propagate PG failures', async () => {
  const { database, events } = createRecordingDatabase({ rows: [{ history_partition_id: 900 }] });
  const timestamp = Date.UTC(2026, 8, 15);
  await saveMetricsHistory(database, 'server-a', 900, { cpu: 1.1234567890123, ping_ct: false, loss_ct: 'false' }, '', timestamp);
  const insert = events.find(event => event.text?.includes('INSERT INTO metrics_history'));
  assert.equal(insert.values[HISTORY_INSERT_COLUMNS.indexOf('cpu')], 1.1234567890123);
  assert.equal(insert.values[HISTORY_INSERT_COLUMNS.indexOf('timestamp')], timestamp);
  assert.equal(insert.values[HISTORY_INSERT_COLUMNS.indexOf('ping_ct')], -1);
  assert.equal(insert.values[HISTORY_INSERT_COLUMNS.indexOf('loss_ct')], -1);
  assert.deepEqual(normalizeProbeMetricRow({ ping_ct: -1, loss_ct: -1, loss_cu: 0 }), { ping_ct: false, loss_ct: false, loss_cu: 0 });
  const failed = createRecordingDatabase({ rows: [{ history_partition_id: 1 }], failQuery: text => text.includes('INSERT') });
  await assert.rejects(saveMetricsHistory(failed.database, 'server-a', 1, {}, '', timestamp), /deliberate/);
  const deleted = createRecordingDatabase();
  await assert.rejects(saveMetricsHistory(deleted.database, 'server-a', 1, {}, '', timestamp), /deleted/);
  assert.ok(deleted.events.every(event => !event.text?.includes('INSERT INTO metrics_history')));
});

test('retention deletes both tables atomically without drop or rename', async () => {
  const { database, events } = createRecordingDatabase();
  assert.equal((await weeklyCleanup(database)).success, true);
  const deletes = events.filter(event => event.text?.startsWith('DELETE'));
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].values[0], deletes[1].values[0]);
  assert.equal(new Date(deletes[0].values[0]).getUTCDay(), 0);
  assert.ok(events.some(event => event.text === 'COMMIT'));
  assert.ok(events.every(event => !/DROP|RENAME/.test(event.text || '')));
});
