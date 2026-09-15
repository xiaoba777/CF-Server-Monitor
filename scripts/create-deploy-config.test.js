import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const generatorPath = fileURLToPath(new URL('./create-deploy-config.js', import.meta.url));

async function generateConfiguration(variables, verify) {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-deployment-'));
  try {
    const result = spawnSync(process.execPath, [generatorPath], {
      cwd: directory,
      encoding: 'utf8',
      env: { WORKER_NAME: 'test-monitor', API_USER_NAME: 'admin', ...variables }
    });
    await verify(result, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('PostgreSQL deployment excludes D1 and never serializes credentials', async () => {
  await generateConfiguration({
    DATABASE_BACKEND: 'postgres',
    HYPERDRIVE_ID: 'test-hyperdrive',
    API_SECRET: 'must-not-appear',
    API_USER_NAME: 'quote"\nusername'
  }, async (result, directory) => {
    assert.equal(result.status, 0, result.stderr);
    const output = await readFile(join(directory, 'wrangler.deploy.json'), 'utf8');
    const configuration = JSON.parse(output);
    assert.equal(configuration.d1_databases, undefined);
    assert.equal(configuration.hyperdrive[0].binding, 'HYPERDRIVE');
    assert.equal(configuration.vars.API_USER_NAME, 'quote"\nusername');
    assert.equal(output.includes('must-not-appear'), false);
  });
});

test('D1 rollback configuration does not accidentally bind PostgreSQL', async () => {
  await generateConfiguration({ D1_DATABASE_ID: 'test-d1' }, async (result, directory) => {
    assert.equal(result.status, 0, result.stderr);
    const configuration = JSON.parse(await readFile(join(directory, 'wrangler.deploy.json'), 'utf8'));
    assert.equal(configuration.hyperdrive, undefined);
    assert.equal(configuration.d1_databases[0].database_id, 'test-d1');
  });
});

test('Missing PostgreSQL binding fails rather than falling back to D1', async () => {
  await generateConfiguration({ DATABASE_BACKEND: 'postgres', D1_DATABASE_ID: 'test-d1' }, async result => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HYPERDRIVE_ID/);
  });
});
