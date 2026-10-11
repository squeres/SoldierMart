import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { DemoFaceVerifier } from '../src/face.js';
import { isValidIin } from '../src/iin.js';

const USER = { iin: '030515501234', pin: '1234' };
const OTHER = { iin: '980107304562', pin: '4321' };
const PHOTO = 'AQID'; // любые непустые байты, демо-проверка пропускает
const ADMIN = 'test-admin-key';

const cleanups = [];
after(async () => {
  for (const fn of cleanups) await fn();
});

// По умолчанию каждый тест получает свежую встроенную PostgreSQL в памяти.
// persist: true кладёт базу в папку, чтобы проверить перезапуск сервера.
async function start({ persist = false, ...opts } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  const auditPath = path.join(dir, 'audit.log');
  const app = await createApp({
    ...(persist ? { dataDir: dir } : {}),
    auditPath,
    adminKey: ADMIN,
    rateLimitPerMin: 100000,
    ...opts,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  cleanups.push(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, base, dir, auditPath };
}

async function call(base, method, url, { token, body, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = admin;
  const r = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

const login = (base, u = USER, pin = u.pin) =>
  call(base, 'POST', '/api/login', { body: { iin: u.iin, pin } });
const face = (base, pendingToken, image = PHOTO) =>
  call(base, 'POST', '/api/face', { body: { pendingToken, image } });

async function fullLogin(base, u = USER) {
  const l = await login(base, u);
  assert.equal(l.status, 200);
  const f = await face(base, l.json.pendingToken);
  assert.equal(f.status, 200);
  assert.equal(f.json.result, 'match');
  return f.json.sessionToken;
}

// ---------- ИИН ----------

test('проверка ИИН: корректные и некорректные', () => {
  assert.equal(isValidIin(USER.iin), true);
  assert.equal(isValidIin(OTHER.iin), true);
  assert.equal(isValidIin('030515501235'), false); // неверная контрольная цифра
  assert.equal(isValidIin('12345'), false);
  assert.equal(isValidIin('0305155012a4'), false);
  assert.equal(isValidIin(undefined), false);
});

// ---------- вход ----------

test('вход в три шага: после ИИН+ПИН доступа ещё нет, после лица есть', async () => {
  const { base } = await start();

  const l = await login(base);
  assert.equal(l.status, 200);
  assert.equal(l.json.status, 'ok');
  assert.equal(l.json.faceDemo, true);

  // pendingToken не даёт доступа к данным
  const early = await call(base, 'GET', '/api/catalog', { token: l.json.pendingToken });
  assert.equal(early.status, 401);

  const f = await face(base, l.json.pendingToken);
  assert.equal(f.json.result, 'match');
  assert.equal(f.json.user.name, 'Серик Алимов');
  assert.equal(f.json.balance, 25000);
  assert.equal('pinHash' in f.json.user, false);

  const cat = await call(base, 'GET', '/api/catalog', { token: f.json.sessionToken });
  assert.equal(cat.status, 200);
  assert.ok(cat.json.products.length >= 20);
});

test('без токена и с чужим токеном данные не отдаются', async () => {
  const { base } = await start();
  assert.equal((await call(base, 'GET', '/api/catalog')).status, 401);
  assert.equal((await call(base, 'GET', '/api/me', { token: 'a'.repeat(48) })).status, 401);
});

test('неверный ПИН: счётчик попыток, затем блокировка; верный ПИН после блокировки не пускает', async () => {
  const { base } = await start();

  for (let left = 4; left >= 1; left--) {
    const r = await login(base, USER, '0000');
    assert.equal(r.status, 401);
    assert.equal(r.json.status, 'wrong');
    assert.equal(r.json.attemptsLeft, left);
  }
  const fifth = await login(base, USER, '0000');
  assert.equal(fifth.status, 423);
  assert.equal(fifth.json.status, 'locked');

  const correct = await login(base, USER); // верный ПИН
  assert.equal(correct.status, 423);
  assert.equal(correct.json.pendingToken, undefined);
});

test('верный ПИН сбрасывает счётчик ошибок', async () => {
  const { base } = await start();
  for (let i = 0; i < 4; i++) await login(base, USER, '0000');
  assert.equal((await login(base)).status, 200);
  for (let i = 0; i < 4; i++) {
    assert.equal((await login(base, USER, '0000')).status, 401);
  }
});

test('неизвестный ИИН ведёт себя так же, как известный', async () => {
  const { base } = await start();
  const ghost = { iin: '000908503211', pin: '1111' };
  assert.equal(isValidIin(ghost.iin), true);
  const r1 = await login(base, ghost, '0000');
  assert.equal(r1.status, 401);
  assert.equal(r1.json.attemptsLeft, 4);
  for (let i = 0; i < 3; i++) await login(base, ghost, '0000');
  assert.equal((await login(base, ghost, '0000')).status, 423);
});

test('параллельный перебор ПИН не обходит блокировку', async () => {
  const { base } = await start();
  const pins = Array.from({ length: 200 }, (_, i) => String(i).padStart(4, '0'));
  // верный ПИН 1234 находится среди попыток, но блокировка должна сработать раньше
  const wrong = pins.filter((p) => p !== USER.pin).slice(0, 60);
  const results = await Promise.all([
    ...wrong.map((p) => login(base, USER, p)),
    login(base, USER, USER.pin),
  ]);
  const success = results.filter((r) => r.status === 200);
  const locked = results.filter((r) => r.status === 423);
  assert.ok(locked.length > 0, 'аккаунт должен заблокироваться');
  // допустим успех только если верный ПИН «успел» обработаться до 5-й ошибки
  assert.ok(success.length <= 1);
  assert.equal((await login(base)).status, 423);
});

test('плохой ввод отклоняется', async () => {
  const { base } = await start();
  assert.equal((await call(base, 'POST', '/api/login', { body: { iin: '123', pin: '1234' } })).status, 400);
  assert.equal((await call(base, 'POST', '/api/login', { body: { iin: USER.iin, pin: '12' } })).status, 400);
  assert.equal((await call(base, 'POST', '/api/login', { body: { iin: USER.iin, pin: 1234 } })).status, 400);
});

// ---------- лицо ----------

test('неудачи проверки лица копятся между сеансами и блокируют аккаунт', async () => {
  const { base } = await start({ face: new DemoFaceVerifier({ forced: 'noMatch' }) });

  const l1 = await login(base);
  assert.equal(l1.json.faceAttemptsLeft, 3);
  assert.equal((await face(base, l1.json.pendingToken)).json.attemptsLeft, 2);
  assert.equal((await face(base, l1.json.pendingToken)).json.attemptsLeft, 1);

  // «вышел» и зашёл заново: счётчик не сбросился
  const l2 = await login(base);
  assert.equal(l2.json.faceAttemptsLeft, 1);
  const last = await face(base, l2.json.pendingToken);
  assert.equal(last.status, 423);
  assert.equal(last.json.locked, true);

  assert.equal((await login(base)).status, 423);
});

test('noFace и error не считаются неудачной попыткой', async () => {
  const { base } = await start({ face: new DemoFaceVerifier({ forced: 'noFace' }) });
  const l = await login(base);
  for (let i = 0; i < 10; i++) {
    const f = await face(base, l.json.pendingToken);
    assert.equal(f.status, 200);
    assert.equal(f.json.result, 'noFace');
    assert.equal(f.json.attemptsLeft, 3);
  }
});

test('шаг лица нельзя повторно использовать после входа', async () => {
  const { base } = await start();
  const l = await login(base);
  assert.equal((await face(base, l.json.pendingToken)).status, 200);
  assert.equal((await face(base, l.json.pendingToken)).status, 401);
});

test('без снимка и с несуществующим токеном лицо не проходит', async () => {
  const { base } = await start();
  const l = await login(base);
  assert.equal((await call(base, 'POST', '/api/face', { body: { pendingToken: l.json.pendingToken } })).status, 400);
  assert.equal((await face(base, 'f'.repeat(48))).status, 401);
});

// ---------- разблокировка ----------

test('разблокировка дежурным: только с ключом, возвращает возможность входа', async () => {
  const { base } = await start();
  for (let i = 0; i < 5; i++) await login(base, USER, '0000');
  assert.equal((await login(base)).status, 423);

  const body = { iin: USER.iin };
  assert.equal((await call(base, 'POST', '/admin/unlock', { body })).status, 403);
  assert.equal((await call(base, 'POST', '/admin/unlock', { body, admin: 'wrong' })).status, 403);

  const list = await call(base, 'GET', '/admin/locked', { admin: ADMIN });
  assert.equal(list.json.locked.length, 1);
  assert.equal(list.json.locked[0].iin, USER.iin);

  const un = await call(base, 'POST', '/admin/unlock', { body, admin: ADMIN });
  assert.equal(un.status, 200);
  assert.equal(un.json.wasLocked, true);

  assert.equal((await login(base)).status, 200);
  assert.equal((await login(base, USER, '0000')).json.attemptsLeft, 4);
});

// ---------- заказы ----------

test('заказ: баланс и остатки меняются на сервере, возвращается код выдачи', async () => {
  const { base } = await start();
  const token = await fullLogin(base);

  const before = (await call(base, 'GET', '/api/catalog', { token })).json.products.find((p) => p.id === 'f1');

  const r = await call(base, 'POST', '/api/orders', {
    token,
    body: { requestId: 'req-1', items: [{ productId: 'f1', qty: 2 }, { productId: 'h1', qty: 1 }] },
  });
  assert.equal(r.status, 201);
  assert.match(r.json.order.code, /^\d{6}$/);
  assert.equal(r.json.order.total, 650 * 2 + 250);
  assert.equal(r.json.balance, 25000 - 1550);

  const after = (await call(base, 'GET', '/api/catalog', { token })).json.products.find((p) => p.id === 'f1');
  assert.equal(after.stock, before.stock - 2);

  const me = await call(base, 'GET', '/api/me', { token });
  assert.equal(me.json.balance, 25000 - 1550);

  const history = await call(base, 'GET', '/api/orders', { token });
  assert.equal(history.json.orders.length, 1);
  assert.equal(history.json.orders[0].code, r.json.order.code);
});

test('повтор заказа с тем же requestId не списывает деньги дважды', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  const body = { requestId: 'same-id', items: [{ productId: 'f1', qty: 1 }] };

  const a = await call(base, 'POST', '/api/orders', { token, body });
  const b = await call(base, 'POST', '/api/orders', { token, body });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.replay, true);
  assert.equal(b.json.order.code, a.json.order.code);
  assert.equal(b.json.balance, 25000 - 650);
  assert.equal((await call(base, 'GET', '/api/orders', { token })).json.orders.length, 1);
});

test('заказ: нехватка средств, нехватка товара, неверные данные', async () => {
  const { base } = await start();
  const token = await fullLogin(base, OTHER); // баланс 8000

  const poor = await call(base, 'POST', '/api/orders', {
    token,
    body: { items: [{ productId: 'c2', qty: 2 }] }, // 2 * 6500 = 13000
  });
  assert.equal(poor.status, 409);
  assert.equal(poor.json.error, 'insufficient_funds');

  const none = await call(base, 'POST', '/api/orders', {
    token,
    body: { items: [{ productId: 'f1', qty: 99 }, { productId: 'f1', qty: 99 }] }, // 198 > 120
  });
  assert.equal(none.status, 409);
  assert.equal(none.json.error, 'out_of_stock');

  for (const items of [[], [{ productId: 'zzz', qty: 1 }], [{ productId: 'f1', qty: 0 }], [{ productId: 'f1', qty: 1.5 }], 'x']) {
    const r = await call(base, 'POST', '/api/orders', { token, body: { items } });
    assert.equal(r.status, 400, JSON.stringify(items));
  }
  assert.equal((await call(base, 'GET', '/api/me', { token })).json.balance, 8000); // ничего не списано
});

test('цену нельзя подменить с клиента', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  const r = await call(base, 'POST', '/api/orders', {
    token,
    body: { items: [{ productId: 'f1', qty: 1, price: 1 }] },
  });
  assert.equal(r.json.order.total, 650);
});

test('коды выдачи активных заказов не повторяются', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  const codes = new Set();
  for (let i = 0; i < 15; i++) {
    const r = await call(base, 'POST', '/api/orders', {
      token,
      body: { requestId: `r${i}`, items: [{ productId: 's1', qty: 1 }] },
    });
    codes.add(r.json.order.code);
  }
  assert.equal(codes.size, 15);
});

// ---------- избранное ----------

test('избранное хранится на сервере по аккаунтам', async () => {
  const { base } = await start();
  const t1 = await fullLogin(base, USER);
  const t2 = await fullLogin(base, OTHER);

  assert.deepEqual((await call(base, 'PUT', '/api/favorites/f1', { token: t1 })).json.favorites, ['f1']);
  assert.deepEqual((await call(base, 'PUT', '/api/favorites/h2', { token: t1 })).json.favorites, ['f1', 'h2']);
  assert.deepEqual((await call(base, 'GET', '/api/me', { token: t2 })).json.favorites, []);
  assert.deepEqual((await call(base, 'DELETE', '/api/favorites/f1', { token: t1 })).json.favorites, ['h2']);
  assert.equal((await call(base, 'PUT', '/api/favorites/nope', { token: t1 })).status, 404);

  // при следующем входе избранное возвращается
  const again = await login(base, USER);
  const f = await face(base, again.json.pendingToken);
  assert.deepEqual(f.json.favorites, ['h2']);
});

// ---------- выход, хранение, журнал ----------

test('выход закрывает сеанс', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  assert.equal((await call(base, 'POST', '/api/logout', { token })).status, 200);
  assert.equal((await call(base, 'GET', '/api/me', { token })).status, 401);
});

test('данные, блокировки и ПИН-хэши переживают перезапуск сервера', async () => {
  const first = await start({ persist: true });
  const token = await fullLogin(first.base);
  await call(first.base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 1 }] } });
  for (let i = 0; i < 5; i++) await login(first.base, OTHER, '0000');
  await first.app.close();

  const second = await createApp({ dataDir: first.dir, adminKey: ADMIN, rateLimitPerMin: 100000 });
  await new Promise((r) => second.server.listen(0, '127.0.0.1', r));
  cleanups.push(() => second.close());
  const base2 = `http://127.0.0.1:${second.server.address().port}`;

  assert.equal((await login(base2, OTHER)).status, 423); // блокировка сохранилась
  const t = await fullLogin(base2, USER);
  assert.equal((await call(base2, 'GET', '/api/me', { token: t })).json.balance, 25000 - 650);

  const { rows } = await second.db.query('SELECT pin_salt, pin_hash FROM users');
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.equal(`${r.pin_salt}${r.pin_hash}`.includes('1234'), false, 'ПИН не должен храниться открытым текстом');
    assert.match(r.pin_hash, /^[0-9a-f]{64}$/);
  }
});

test('в журнале нет ПИН, полного ИИН и снимков', async () => {
  const { base, auditPath } = await start();
  await login(base, USER, '9999');
  await fullLogin(base);
  const log = fs.readFileSync(auditPath, 'utf8');
  assert.ok(log.includes('pin_wrong'));
  assert.ok(log.includes('login_ok'));
  assert.equal(log.includes(USER.iin), false);
  assert.equal(log.includes('9999'), false);
  assert.equal(log.includes(PHOTO), false);
});

test('лимит запросов на вход с одного адреса', async () => {
  const { base } = await start({ rateLimitPerMin: 5 });
  let last;
  for (let i = 0; i < 7; i++) last = await login(base, USER, '0000');
  assert.equal(last.status, 429);
});

test('CORS: предзапрос браузера (Chrome) проходит', async () => {
  const { base } = await start();
  const r = await fetch(base + '/api/login', {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5555', 'access-control-request-method': 'POST' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});
