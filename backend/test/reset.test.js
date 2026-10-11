import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from '../src/db.js';

const cleanups = [];
after(() => {
  for (const fn of cleanups) fn();
});
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const run = (dir, extraEnv = {}) =>
  spawnSync(process.execPath, ['reset-db.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dir, DATABASE_URL: '', ...extraEnv },
    encoding: 'utf8',
  });

test('повреждённая встроенная база даёт понятную ошибку с подсказкой, а не дамп', async () => {
  const dir = tmp('sm-broken-');
  const db = await openDb({ dataDir: dir });
  await db.close();
  // портим служебный файл, как после аварийной остановки
  fs.rmSync(path.join(dir, 'pgdata', 'global', 'pg_control'), { force: true });
  await assert.rejects(openDb({ dataDir: dir }), (e) => {
    assert.match(e.message, /Встроенная база не открылась/);
    assert.match(e.message, /npm run db:reset/);
    assert.match(e.message, /Ctrl\+C/);
    assert.ok(e.message.length < 800, 'короткое сообщение');
    return true;
  });
});

test('db:reset переименовывает папку базы, ничего не удаляя, и после него база создаётся заново', async () => {
  const dir = tmp('sm-reset-');
  const db = await openDb({ dataDir: dir });
  await db.query("INSERT INTO products (id,pos,name_ru,name_kk,category,price,icon,stock) VALUES ('t1',0,'a','b','food',1,'cookie',1)");
  await db.close();

  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Старая база сохранена/);
  assert.equal(fs.existsSync(path.join(dir, 'pgdata')), false);
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('pgdata.broken-'));
  assert.equal(kept.length, 1);
  assert.ok(fs.existsSync(path.join(dir, kept[0], 'PG_VERSION')), 'данные на месте, переименованы');

  const fresh = await openDb({ dataDir: dir });
  assert.equal((await fresh.query('SELECT count(*)::int AS n FROM products')).rows[0].n, 0);
  await fresh.close();
});

test('db:reset: нечего сбрасывать и режим PostgreSQL обрабатываются без вреда', () => {
  const dir = tmp('sm-reset2-');
  const none = run(dir);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /нечего/);
  const pg = run(dir, { DATABASE_URL: 'postgres://x' });
  assert.equal(pg.status, 2);
  assert.match(pg.stderr, /DATABASE_URL/);
});
