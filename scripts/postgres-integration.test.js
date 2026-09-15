import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PostgresDatabase } from '../src/database/postgres.js';
import { POSTGRES_SCHEMA_STATEMENTS, validatePostgresSchema } from '../src/database/postgresSchema.js';
import { savePostgresJwtSecret, savePostgresThemeOptions } from '../src/database/postgresSettings.js';

test('PostgreSQL schema and adapter execute with real PostgreSQL semantics', async context => {
  const engine = new PGlite();
  context.after(() => engine.close());
  const database = new PostgresDatabase('embedded-test', async () => ({
    async connect() {},
    async end() {},
    async query(statement) {
      const result = typeof statement === 'string'
        ? await engine.query(statement)
        : await engine.query(statement.text, statement.values);
      return { rows: result.rows, rowCount: result.affectedRows };
    }
  }));

  for (const statement of POSTGRES_SCHEMA_STATEMENTS) await engine.exec(statement);
  await validatePostgresSchema(database);

  await context.test('millisecond timestamps and partition IDs retain exact values', async () => {
    const historyId = 8990260915102030;
    const timestamp = 1789467630000;
    await database.prepare('INSERT INTO servers (id, history_partition_id, timestamp) VALUES (?, ?, ?)')
      .bind('integration-server', 899, timestamp).run();
    await database.prepare('INSERT INTO metrics_history (id, server_id, timestamp) VALUES (?, ?, ?)')
      .bind(historyId, 'integration-server', timestamp).run();
    const history = await database.prepare('SELECT id, timestamp FROM metrics_history WHERE server_id = ? ORDER BY timestamp DESC LIMIT ?')
      .bind('integration-server', 1).first();
    assert.equal(Number(history.id), historyId);
    assert.equal(Number(history.timestamp), timestamp);
  });

  await context.test('duplicate history partition fails instead of mixing server histories', async () => {
    await assert.rejects(database.prepare('INSERT INTO servers (id, history_partition_id) VALUES (?, ?)')
      .bind('different-server', 899).run(), /unique|duplicate/i);
  });

  await context.test('failed batch rolls back earlier writes', async () => {
    await assert.rejects(database.batch([
      database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('transaction-test', 'first'),
      database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('transaction-test', 'duplicate')
    ]), /unique|duplicate/i);
    assert.equal(await database.prepare('SELECT value FROM settings WHERE key = ?').bind('transaction-test').first(), null);
  });

  await context.test('JWT initialization preserves existing valid secrets and unrelated settings', async () => {
    const originalSecret = 'original-secret-that-is-long-enough-for-validation';
    await database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .bind('site_options', JSON.stringify({ jwt_secret: originalSecret, is_public: 'false' })).run();
    assert.equal(await savePostgresJwtSecret(database, 'different-secret-also-long-enough', 32), originalSecret);
    const settings = JSON.parse(await database.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('site_options').first('value'));
    assert.equal(settings.is_public, 'false');
  });

  await context.test('theme update safely replaces malformed legacy JSON', async () => {
    await database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .bind('appearance_options', 'legacy plain text').run();
    await savePostgresThemeOptions(database, { background: 'dark' });
    const appearance = JSON.parse(await database.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('appearance_options').first('value'));
    assert.deepEqual(appearance.theme_options, { background: 'dark' });
  });
});
