import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { MIGRATIONS } from '../src/schema.js';
import { hashPin } from '../src/pin.js';
import { encryptJson, toKey } from '../src/secret.js';

const USER = { iin: '030515501234', pin: '1234' };
const ADMIN = 'test-admin-key';
const cleanups = [];
after(async () => {
  for (const fn of cleanups) await fn();
});

const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function start(opts = {}) {
  const app = await createApp({ adminKey: ADMIN, rateLimitPerMin: 100000, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  cleanups.push(() => app.close());
  return { app, base };
}

async function call(base, method, url, { token, body, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = admin;
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

async function fullLogin(base, u = USER) {
  const l = await call(base, 'POST', '/api/login', { body: { iin: u.iin, pin: u.pin } });
  const f = await call(base, 'POST', '/api/face', { body: { pendingToken: l.json.pendingToken, image: 'AQID' } });
  return f.json.sessionToken;
}

// ---------- схема и ограничения ----------

test('миграции записываются один раз и при повторном открытии не повторяются', async () => {
  const dir = tmp('sm-db-');
  const a = await openDb({ dataDir: dir });
  const v1 = (await a.query('SELECT version FROM schema_version ORDER BY version')).rows.map((r) => r.version);
  assert.deepEqual(v1, MIGRATIONS.map((m) => m.version));
  await a.close();
  const b = await openDb({ dataDir: dir });
  assert.equal((await b.query('SELECT count(*)::int AS n FROM schema_version')).rows[0].n, MIGRATIONS.length);
  await b.close();
});

test('база сама не даёт уйти в минус: баланс и остаток под CHECK', async () => {
  const { app } = await start();
  await assert.rejects(app.db.query("UPDATE users SET balance = -1 WHERE iin = $1", [USER.iin]), /check|constraint/i);
  await assert.rejects(app.db.query("UPDATE products SET stock = -1 WHERE id = 'f1'"), /check|constraint/i);
  await assert.rejects(app.db.query("INSERT INTO users (iin,name,unit,balance,pin_salt,pin_hash) VALUES ('123','x','y',0,'a','b')"), /check|constraint/i);
});

test('откат: ошибка внутри транзакции не оставляет половину изменений', async () => {
  const { app } = await start();
  const before = (await app.db.query('SELECT balance FROM users WHERE iin = $1', [USER.iin])).rows[0].balance;
  await assert.rejects(
    app.db.tx(async (t) => {
      await t.query('UPDATE users SET balance = balance - 100 WHERE iin = $1', [USER.iin]);
      await t.query("UPDATE products SET stock = -5 WHERE id = 'f1'"); // нарушает CHECK
    }),
  );
  const after = (await app.db.query('SELECT balance FROM users WHERE iin = $1', [USER.iin])).rows[0].balance;
  assert.equal(after, before);
});

test('токены в базе хранятся хэшем: по содержимому таблицы сеанс не воссоздать', async () => {
  const { app, base } = await start();
  const token = await fullLogin(base);
  const { rows } = await app.db.query('SELECT token_hash FROM sessions');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test('демо-пользователи добавляются только по просьбе и только в пустую базу', async () => {
  const none = await start({ seedDemoUsers: false });
  assert.equal((await none.app.db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  assert.ok((await none.app.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n > 10, 'каталог есть всегда');
  assert.equal((await call(none.base, 'POST', '/api/login', { body: { iin: USER.iin, pin: USER.pin } })).status, 401);
});

// ---------- гонки ----------

test('параллельные заказы не продают больше остатка и не уводят баланс в минус', async () => {
  const { app, base } = await start();
  await app.db.query("UPDATE products SET stock = 3 WHERE id = 'f1'");
  await app.db.query('UPDATE users SET balance = 100000 WHERE iin = $1', [USER.iin]);
  const token = await fullLogin(base);
  const rs = await Promise.all(
    Array.from({ length: 8 }, () =>
      call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 1 }] } }),
    ),
  );
  assert.equal(rs.filter((r) => r.status === 201).length, 3);
  assert.equal(rs.filter((r) => r.status === 409).length, 5);
  assert.equal((await app.db.query("SELECT stock FROM products WHERE id = 'f1'")).rows[0].stock, 0);
  assert.equal((await app.db.query('SELECT balance FROM users WHERE iin = $1', [USER.iin])).rows[0].balance, 100000 - 3 * 650);
});

test('параллельные повторы с одним requestId дают один заказ и одно списание', async () => {
  const { app, base } = await start();
  const token = await fullLogin(base);
  const body = { requestId: 'same', items: [{ productId: 'f1', qty: 2 }] };
  const rs = await Promise.all(Array.from({ length: 6 }, () => call(base, 'POST', '/api/orders', { token, body })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(rs.filter((r) => r.status === 200 && r.json.replay).length, 5);
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1);
  assert.equal((await app.db.query('SELECT balance FROM users WHERE iin = $1', [USER.iin])).rows[0].balance, 25000 - 1300);
});

test('баланс всегда равен сумме журнала после заказов, отмен и пополнений', async () => {
  const { app, base } = await start();
  const token = await fullLogin(base);
  const o1 = await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 2 }] } });
  await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'c2', qty: 1 }] } });
  await call(base, 'POST', '/admin/orders/cancel', { admin: ADMIN, body: { id: o1.json.order.id } });
  await call(base, 'POST', '/admin/balance', { admin: ADMIN, body: { iin: USER.iin, amount: 1234, note: 'x' } });
  const { rows } = await app.db.query(
    `SELECT u.balance, 25000 + coalesce(sum(l.amount), 0)::int AS expected
       FROM users u LEFT JOIN ledger l ON l.iin = u.iin WHERE u.iin = $1 GROUP BY u.balance`,
    [USER.iin],
  );
  assert.equal(rows[0].balance, rows[0].expected);
  const last = (await app.db.query('SELECT balance FROM ledger WHERE iin = $1 ORDER BY id DESC LIMIT 1', [USER.iin])).rows[0];
  assert.equal(last.balance, rows[0].balance, 'остаток в последней записи журнала совпадает');
});

test('счётчик неверных ПИН атомарен: параллельный перебор блокирует ровно на лимите', async () => {
  const { app, base } = await start();
  const rs = await Promise.all(
    Array.from({ length: 30 }, () => call(base, 'POST', '/api/login', { body: { iin: USER.iin, pin: '0000' } })),
  );
  assert.equal(rs.filter((r) => r.status === 401).length, 4, 'ровно 4 ответа «неверно», пятый блокирует');
  assert.equal(rs.filter((r) => r.status === 423).length, 26);
  const { rows } = await app.db.query('SELECT strikes FROM security WHERE iin = $1', [USER.iin]);
  assert.equal(rows[0].strikes, 1, 'блокировка засчитана один раз, а не по числу запросов');
});

test('порядок заказов строгий, даже если они созданы в одну миллисекунду', async () => {
  const { app, base } = await start();
  const token = await fullLogin(base);
  const ids = [];
  for (const id of ['f1', 'f8', 'h1', 's1']) {
    ids.push((await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: id, qty: 1 }] } })).json.order.id);
  }
  const list = (await call(base, 'GET', '/api/orders', { token })).json.orders.map((o) => o.id);
  assert.deepEqual(list, ids.reverse());
});

// ---------- перенос из db.json ----------

function legacyDb(key) {
  const mk = async (iin, name, pin, balance) => ({ iin, name, unit: 'в/ч 1', balance, ...(await hashPin(pin)) });
  return (async () => ({
    users: { [USER.iin]: await mk(USER.iin, 'Серик Алимов', '1234', 4321) },
    products: [
      { id: 'f1', nameRu: 'Печенье', nameKk: 'Печенье', category: 'food', price: 650, icon: 'cookie', stock: 7 },
      { id: 'f8', nameRu: 'Вода', nameKk: 'Су', category: 'food', price: 220, icon: 'water_drop', stock: 9 },
    ],
    favorites: { [USER.iin]: ['f8'] },
    orders: [
      {
        id: '11111111-1111-4111-8111-111111111111', iin: USER.iin, requestId: 'r1', code: '123456', status: 'ready',
        total: 650, createdAt: '2026-10-01T10:00:00.000Z',
        items: [{ productId: 'f1', nameRu: 'Печенье', nameKk: 'Печенье', price: 650, qty: 1 }],
      },
    ],
    ledger: [{ t: '2026-10-01T10:00:00.000Z', iin: USER.iin, type: 'order', amount: -650, balance: 4321 }],
    ...(key
      ? { faceTemplatesEnc: encryptJson(key, { [USER.iin]: [[0.5, 0.25]] }) }
      : { faceTemplates: { [USER.iin]: [[0.5, 0.25]] } }),
    security: { locked: { [USER.iin]: { at: '2026-10-02T00:00:00.000Z', reason: 'face' } }, pinFails: {}, faceFails: { [USER.iin]: 1 }, strikes: {} },
  }))();
}

test('перенос db.json в базу: данные, шифрование и блокировки сохраняются, повторный перенос отказывает', async () => {
  const dir = tmp('sm-mig-');
  const key = toKey('migration-secret');
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(await legacyDb(key)));

  const env = { ...process.env, DATA_DIR: dir, DATA_KEY: 'migration-secret', DATABASE_URL: '' };
  const run = (...args) => spawnSync(process.execPath, ['migrate-json.js', ...args], { env, encoding: 'utf8', cwd: path.join(import.meta.dirname, '..') });

  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /users: 1/);
  assert.ok(fs.existsSync(path.join(dir, 'db.json.imported')));

  const again = run();
  assert.notEqual(again.status, 0, 'во второй раз в непустую базу перенос не идёт без --replace');
  assert.match(again.stderr, /уже есть данные/);

  const app = await createApp({ dataDir: dir, adminKey: ADMIN, secretKey: 'migration-secret', seedDemoUsers: false });
  cleanups.push(() => app.close());
  const u = await app.repo.getUser(USER.iin);
  assert.equal(u.balance, 4321);
  assert.deepEqual(await app.repo.listTemplates(USER.iin), [[0.5, 0.25]]);
  const orders = await app.repo.listUserOrders(USER.iin);
  assert.equal(orders[0].code, '123456');
  assert.equal(orders[0].items[0].qty, 1);
  assert.deepEqual(await app.repo.listFavorites(USER.iin), ['f8']);
  const sec = await app.repo.getSecurity(USER.iin);
  assert.equal(sec.locked, true);
  assert.equal(sec.reason, 'face');
  assert.equal(sec.faceFails, 1);
  assert.equal((await app.db.query('SELECT stock FROM products WHERE id = $1', ['f1'])).rows[0].stock, 7);
});

test('перенос без ключа для зашифрованных шаблонов отказывает и ничего не пишет', async () => {
  const dir = tmp('sm-mig2-');
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(await legacyDb(toKey('k'))));
  const r = spawnSync(process.execPath, ['migrate-json.js'], {
    env: { ...process.env, DATA_DIR: dir, DATA_KEY: '', DATABASE_URL: '' },
    encoding: 'utf8',
    cwd: path.join(import.meta.dirname, '..'),
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ключа нет/);
  assert.equal(fs.existsSync(path.join(dir, 'pgdata')), false, 'база даже не создавалась');
});

// ---------- управление товарами ----------

const adminCall = (base, method, url, body) => call(base, method, url, { admin: ADMIN, body });
const NEW = { nameRu: 'Фонарик', category: 'stationery', icon: 'flashlight_on', price: 2500, stock: 5 };

test('дежурный добавляет товар: он виден в приложении, продаётся и считается в остатках', async () => {
  const { app, base } = await start();
  const created = await adminCall(base, 'POST', '/admin/products', NEW);
  assert.equal(created.status, 201);
  const p = created.json.product;
  assert.equal(p.nameKk, 'Фонарик', 'без казахского названия берётся русское');
  assert.equal(p.active, true);
  assert.match(p.id, /^p[0-9a-f]{8}$/);

  const token = await fullLogin(base);
  const cat = await call(base, 'GET', '/api/catalog', { token });
  assert.ok(cat.json.products.some((x) => x.id === p.id && x.price === 2500));
  assert.equal(cat.json.products.at(-1).id, p.id, 'новый товар в конце каталога');

  const o = await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: p.id, qty: 5 }] } });
  assert.equal(o.status, 201);
  assert.equal((await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: p.id, qty: 1 }] } })).status, 409);
  assert.equal((await app.db.query('SELECT stock FROM products WHERE id = $1', [p.id])).rows[0].stock, 0);
  const list = await adminCall(base, 'GET', '/admin/products');
  assert.equal(list.json.products.find((x) => x.id === p.id).sold, 5);
  assert.ok(list.json.categories.length >= 4 && list.json.icons.includes('flashlight_on'));
});

test('проверка полей товара: плохие значения отклоняются с названием поля', async () => {
  const { base } = await start();
  const bad = async (patch, field) => {
    const r = await adminCall(base, 'POST', '/admin/products', { ...NEW, ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.equal(r.json.field, field);
  };
  await bad({ nameRu: '   ' }, 'nameRu');
  await bad({ nameRu: 'x'.repeat(121) }, 'nameRu');
  await bad({ category: 'weapons' }, 'category');
  await bad({ icon: 'DROP TABLE' }, 'icon');
  await bad({ price: -1 }, 'price');
  await bad({ price: 10.5 }, 'price');
  await bad({ price: '100' }, 'price');
  await bad({ stock: -3 }, 'stock');
  await bad({ id: 'плохой код!' }, 'id');
  assert.equal((await adminCall(base, 'POST', '/admin/products', { ...NEW, id: 'f1' })).status, 409, 'код уже занят');
  assert.equal((await call(base, 'POST', '/admin/products', { body: NEW })).status, 403, 'без ключа нельзя');
});

test('изменение товара: цена и название меняются, старые заказы сохраняют прежнюю цену', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  const o = await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 1 }] } });
  assert.equal(o.status, 201);
  const r = await adminCall(base, 'PUT', '/admin/products/f1', { price: 999, nameRu: 'Печенье новое' });
  assert.equal(r.status, 200);
  assert.equal(r.json.product.price, 999);
  assert.equal((await adminCall(base, 'PUT', '/admin/products/f1', {})).status, 400, 'пустое изменение');
  assert.equal((await adminCall(base, 'PUT', '/admin/products/nope', { price: 1 })).status, 404);
  assert.equal((await adminCall(base, 'PUT', '/admin/products/f1', { category: 'x' })).status, 400);

  const mine = (await call(base, 'GET', '/api/orders', { token })).json.orders;
  assert.equal(mine[0].items[0].price, 650);
  assert.equal(mine[0].items[0].nameRu, 'Печенье овсяное, 300 г');
  const next = await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 1 }] } });
  assert.equal(next.json.order.total, 999, 'новый заказ по новой цене');
});

test('скрытый товар пропадает из приложения и избранного, не продаётся; можно вернуть', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  await call(base, 'PUT', '/api/favorites/f1', { token });
  assert.deepEqual((await call(base, 'GET', '/api/me', { token })).json.favorites, ['f1']);

  assert.equal((await adminCall(base, 'PUT', '/admin/products/f1', { active: false })).json.product.active, false);
  assert.equal((await call(base, 'GET', '/api/catalog', { token })).json.products.some((p) => p.id === 'f1'), false);
  assert.deepEqual((await call(base, 'GET', '/api/me', { token })).json.favorites, []);
  assert.equal((await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 1 }] } })).status, 400);
  assert.equal((await call(base, 'PUT', '/api/favorites/f1', { token })).status, 404);
  assert.equal((await adminCall(base, 'GET', '/admin/products')).json.products.find((p) => p.id === 'f1').active, false, 'дежурный его видит');

  await adminCall(base, 'PUT', '/admin/products/f1', { active: true });
  assert.equal((await call(base, 'GET', '/api/catalog', { token })).json.products.some((p) => p.id === 'f1'), true);
  assert.deepEqual((await call(base, 'GET', '/api/me', { token })).json.favorites, ['f1'], 'избранное вернулось');
});

test('приход и списание остатка атомарны, в минус уйти нельзя', async () => {
  const { app, base } = await start();
  const stockOf = async () => (await app.db.query("SELECT stock FROM products WHERE id = 'h6'")).rows[0].stock;
  const s0 = await stockOf();
  assert.equal((await adminCall(base, 'POST', '/admin/products/h6/stock', { delta: 10 })).json.product.stock, s0 + 10);
  assert.equal((await adminCall(base, 'POST', '/admin/products/h6/stock', { delta: -(s0 + 11) })).status, 409);
  assert.equal(await stockOf(), s0 + 10, 'отказ ничего не изменил');
  assert.equal((await adminCall(base, 'POST', '/admin/products/h6/stock', { delta: 0 })).status, 400);
  assert.equal((await adminCall(base, 'POST', '/admin/products/h6/stock', { delta: 1.5 })).status, 400);
  assert.equal((await adminCall(base, 'POST', '/admin/products/nope/stock', { delta: 1 })).status, 404);
  const rs = await Promise.all(Array.from({ length: 10 }, () => adminCall(base, 'POST', '/admin/products/h6/stock', { delta: 1 })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(await stockOf(), s0 + 20, 'параллельные приходы не теряются');
});

test('удаление: история остаётся, из избранного пропадает, товар в ожидающем заказе удалить нельзя', async () => {
  const { app, base } = await start();
  const token = await fullLogin(base);
  const o = await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 1 }] } });
  await call(base, 'PUT', '/api/favorites/f1', { token });

  const blocked = await adminCall(base, 'DELETE', '/admin/products/f1');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'product_in_active_orders');

  await adminCall(base, 'POST', '/admin/orders/pickup', { id: o.json.order.id });
  assert.equal((await adminCall(base, 'DELETE', '/admin/products/f1')).status, 200);
  assert.equal((await adminCall(base, 'DELETE', '/admin/products/f1')).status, 404);
  assert.equal((await app.db.query("SELECT count(*)::int AS n FROM products WHERE id = 'f1'")).rows[0].n, 0);
  assert.equal((await app.db.query("SELECT count(*)::int AS n FROM favorites WHERE product_id = 'f1'")).rows[0].n, 0);

  const mine = (await call(base, 'GET', '/api/orders', { token })).json.orders;
  assert.equal(mine[0].items[0].nameRu, 'Печенье овсяное, 300 г', 'в истории название на месте');
});

test('отмена заказа с уже удалённым товаром возвращает деньги и не падает', async () => {
  const { app, base } = await start();
  const token = await fullLogin(base);
  const a = await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 1 }, { productId: 'f8', qty: 2 }] } });
  // товар убрали напрямую в базе, в обход защиты от удаления
  await app.db.query("DELETE FROM products WHERE id = 'f1'");
  const c = await adminCall(base, 'POST', '/admin/orders/cancel', { id: a.json.order.id });
  assert.equal(c.status, 200);
  assert.equal(c.json.balance, 25000);
});

test('миграция 2 записана в schema_version', async () => {
  const dir = tmp('sm-mig3-');
  const db = await openDb({ dataDir: dir });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_version WHERE version = 2')).rows[0].n, 1);
  await db.close();
});

test('страница управления товарами отдаётся с защитными заголовками', async () => {
  const { base } = await start();
  const r = await fetch(base + '/panel/catalog');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.ok((await r.text()).includes('управление товарами'));
});
