// Hyperdrive owns the connection pool. Never retain a socket across Worker/DO events.
export function parseSafeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new RangeError(`PostgreSQL integer exceeds JavaScript's safe range: ${value}`);
  }
  return number;
}

// Only parameter markers are translated; SQL dialect differences belong at call sites.
// Quoted literals/identifiers, dollar quotes and comments must remain untouched.
export function compileParameters(sql, values = []) {
  let output = '';
  let position = 0;
  let parameterCount = 0;
  while (position < sql.length) {
    const rest = sql.slice(position);
    const dollarQuote = rest.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
    const character = sql[position];
    if (dollarQuote) {
      const end = sql.indexOf(dollarQuote, position + dollarQuote.length);
      if (end < 0) throw new Error('Unterminated SQL dollar quote');
      output += sql.slice(position, end + dollarQuote.length);
      position = end + dollarQuote.length;
    } else if (character === "'" || character === '"') {
      const start = position++;
      let closed = false;
      while (position < sql.length) {
        if (sql[position++] !== character) continue;
        if (sql[position] === character) { position++; continue; }
        closed = true;
        break;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
      output += sql.slice(start, position);
    } else if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', position);
      const next = end < 0 ? sql.length : end + 1;
      output += sql.slice(position, next);
      position = next;
    } else if (rest.startsWith('/*')) {
      const start = position;
      let depth = 1;
      position += 2;
      while (position < sql.length && depth) {
        if (sql.startsWith('/*', position)) { depth++; position += 2; }
        else if (sql.startsWith('*/', position)) { depth--; position += 2; }
        else position++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      output += sql.slice(start, position);
    } else {
      output += character === '?' ? `$${++parameterCount}` : character;
      position++;
    }
  }
  if (parameterCount !== values.length) throw new Error('SQL parameter count mismatch');
  for (const value of values) {
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new RangeError('Unsafe SQL numeric parameter');
    }
    if (value === undefined) throw new TypeError('Undefined SQL parameter');
  }
  return { text: output, values };
}

async function createClient(connectionString) {
  const { Client, types } = await import('pg');
  return new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    // Per-client parsers avoid changing global pg behavior. JSON remains its native type.
    types: {
      getTypeParser(identifier, format) {
        if (identifier === 20 && format !== 'binary') return parseSafeInteger;
        return types.getTypeParser(identifier, format);
      }
    }
  });
}

class PostgresStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) { return new PostgresStatement(this.database, this.sql, values); }
  async all() {
    const result = await this.database.query(this.sql, this.values);
    return { success: true, results: result.rows, meta: { changes: result.rowCount ?? 0 } };
  }
  async run() { return this.all(); }
  async first(column) {
    const { results } = await this.all();
    if (!results.length) return null;
    if (column === undefined) return results[0];
    if (!(column in results[0])) throw new Error(`Unknown result column: ${column}`);
    return results[0][column];
  }
}

export class PostgresDatabase {
  constructor(connectionString, clientFactory = createClient, transactionClient = null) {
    this.dialect = 'postgres';
    this.connectionString = connectionString;
    this.clientFactory = clientFactory;
    this.transactionClient = transactionClient;
  }
  prepare(sql) { return new PostgresStatement(this, sql); }
  async withClient(operation) {
    if (this.transactionClient) return operation(this.transactionClient);
    const client = await this.clientFactory(this.connectionString);
    try {
      await client.connect();
      return await operation(client);
    } finally {
      await client.end();
    }
  }
  async query(sql, values = []) {
    const query = compileParameters(sql, values);
    return this.withClient(client => client.query(query));
  }
  async transaction(operation) {
    if (this.transactionClient) throw new Error('Nested transactions are not supported');
    return this.withClient(async client => {
      await client.query('BEGIN');
      try {
        // Bound lock waits protect ingestion from admin/maintenance contention.
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '25s'");
        const database = new PostgresDatabase(this.connectionString, this.clientFactory, client);
        const result = await operation(database);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* Keep the original failure. */ }
        throw error;
      }
    });
  }
  async batch(statements) {
    return this.transaction(async database => {
      const results = [];
      for (const statement of statements) {
        if (statement.database !== this) throw new Error('Batch statement belongs to another database');
        results.push(await database.prepare(statement.sql).bind(...statement.values).all());
      }
      return results;
    });
  }
}

export function isPostgres(database) { return database?.dialect === 'postgres'; }

export function withDatabase(env) {
  if (!env.HYPERDRIVE) return env;
  if (!env.HYPERDRIVE.connectionString) throw new Error('HYPERDRIVE connectionString is required');
  // Copy bindings: never mutate the shared env object or silently fall back on PG errors.
  return { ...env, DB: new PostgresDatabase(env.HYPERDRIVE.connectionString) };
}

export const POSTGRES_MIGRATION_REQUIRED = 'PostgreSQL schema changes must be applied with the offline migration tool';
