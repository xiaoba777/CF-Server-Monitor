import { writeFile } from 'node:fs/promises';

function requireVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing deployment variable: ${name}`);
  return value;
}

const databaseBackend = process.env.DATABASE_BACKEND || 'd1';
if (!['d1', 'postgres'].includes(databaseBackend)) {
  throw new Error('DATABASE_BACKEND must be d1 or postgres');
}

const configuration = {
  name: requireVariable('WORKER_NAME'),
  main: 'src/index.js',
  compatibility_date: '2026-09-01',
  compatibility_flags: ['nodejs_compat'],
  keep_vars: true,
  triggers: { crons: ['*/1 * * * *', '0 * * * *'] },
  assets: { directory: './dist', binding: 'ASSETS' },
  durable_objects: {
    bindings: [{ name: 'METRICS_BROADCASTER', class_name: 'MetricsBroadcaster' }]
  },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['MetricsBroadcaster'] }],
  vars: {
    DATABASE_BACKEND: databaseBackend,
    API_USER_NAME: requireVariable('API_USER_NAME'),
    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || ''
  }
};

if (databaseBackend === 'postgres') {
  configuration.hyperdrive = [{
    binding: 'HYPERDRIVE',
    id: requireVariable('HYPERDRIVE_ID')
  }];
} else {
  configuration.d1_databases = [{
    binding: 'DB',
    database_name: 'server-monitor-db',
    database_id: requireVariable('D1_DATABASE_ID')
  }];
}

// Credentials are provisioned with Workers Secrets, never written to this file.
await writeFile('wrangler.deploy.json', `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
console.log(`Generated ${databaseBackend} deployment configuration for ${configuration.name}`);
