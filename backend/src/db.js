import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.js';

/**
 * Доступ к PostgreSQL. Два режима с одним и тем же SQL:
 *  - DATABASE_URL задан: настоящий сервер PostgreSQL через драйвер `pg` (бой, несколько экземпляров сервера);
 *  - иначе: встроенный PostgreSQL (PGlite, WebAssembly) в папке данных или в памяти (разработка и тесты).
 *
 * Интерфейс одинаков: `db.query(sql, params)` и `db.tx(async (t) => { await t.query(...) })`.
 * Внутри `tx` все запросы идут в одной транзакции: ошибка откатывает всё.
 */

class PgDb {
  constructor(pool) {
    this.kind = 'postgres';
    this.pool = pool;
  }

  query(sql, params = []) {
    return this.pool.query(sql, params);
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* соединение могло оборваться */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

class LiteDb {
  constructor(pg) {
    this.kind = 'pglite';
    this.pg = pg;
  }

  query(sql, params = []) {
    return this.pg.query(sql, params);
  }

  tx(fn) {
    return this.pg.transaction((t) => fn(t));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pg.close();
  }
}

/** Применяет недостающие миграции схемы, каждую в своей транзакции. */
async function migrate(db) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  // Блокировка не даёт двум экземплярам сервера мигрировать одновременно (на PGlite один процесс).
  await db.tx(async (t) => {
    if (db.kind === 'postgres') await t.query('SELECT pg_advisory_xact_lock(727001)');
    const { rows } = await t.query('SELECT coalesce(max(version), 0) AS v FROM schema_version');
    const current = Number(rows[0].v);
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      // exec позволяет выполнить несколько команд сразу (в PGlite query принимает одну).
      await (typeof t.exec === 'function' ? t.exec(m.sql) : t.query(m.sql));
      await t.query('INSERT INTO schema_version (version) VALUES ($1)', [m.version]);
    }
  });
}

/**
 * @param {{databaseUrl?: string, dataDir?: string, poolSize?: number}} opts
 *  Если нет ни databaseUrl, ни dataDir, база встроенная и живёт в памяти (для тестов).
 */
export async function openDb({ databaseUrl, dataDir, poolSize = 10 } = {}) {
  let db;
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: poolSize,
      // Целые числа считаем числами, а не строками (все суммы и остатки умещаются в integer).
    });
    pool.on('error', (e) => console.error('Ошибка соединения с БД:', e?.message ?? e));
    db = new PgDb(pool);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    let target;
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      target = path.join(dataDir, 'pgdata');
    }
    db = new LiteDb(new PGlite(target));
    await db.pg.waitReady;
  }
  await migrate(db);
  return db;
}
