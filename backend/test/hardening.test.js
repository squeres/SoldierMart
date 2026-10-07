import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { DemoFaceVerifier } from '../src/face.js';
import { RealFaceVerifier } from '../src/face-real.js';

const USER = { iin: '030515501234', pin: '1234' };
const ADMIN = 'test-admin-key';
const cleanups = [];
after(async () => {
  for (const fn of cleanups) await fn();
});

async function start(opts = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hard-'))) {
  const dbPath = path.join(dir, 'db.json');
  const app = await createApp({ dbPath, adminKey: ADMIN, rateLimitPerMin: 100000, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  cleanups.push(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, base, dir, dbPath };
}

async function call(base, method, url, { token, body, admin, headers: extra } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = admin;
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null, headers: r.headers };
}
const login = (base, pin = USER.pin) => call(base, 'POST', '/api/login', { body: { iin: USER.iin, pin } });
const face = (base, pendingToken) => call(base, 'POST', '/api/face', { body: { pendingToken, image: 'AQID' } });
async function fullLogin(base) {
  const l = await login(base);
  return (await face(base, l.json.pendingToken)).json.sessionToken;
}
const admin = (base, method, url, body) => call(base, method, url, { admin: ADMIN, body });

// ---------- временная блокировка ----------

test('блокировка по ПИН временная, снимается сама и растёт при повторах', async () => {
  const { base, app } = await start({ pinLockBaseMs: 1000 });
  for (let i = 0; i < 4; i++) await login(base, '0000');
  const fifth = await login(base, '0000');
  assert.equal(fifth.status, 423);
  assert.equal(fifth.json.retryAfterSec, 1);

  // имитируем, что время блокировки вышло
  app.store.data.security.locked[USER.iin].until = new Date(Date.now() - 1).toISOString();
  const ok = await login(base);
  assert.equal(ok.status, 200, 'после срока верный ПИН снова пускает');

  // вторая блокировка подряд вдвое дольше
  for (let i = 0; i < 5; i++) await login(base, '0000');
  const until = Date.parse(app.store.data.security.locked[USER.iin].until);
  assert.ok(until - Date.now() > 1200, 'вторая блокировка длиннее первой');
});

test('блокировка по лицу жёсткая: сама не снимается, снимает дежурный', async () => {
  const { base, app } = await start({ face: new DemoFaceVerifier({ forced: 'noMatch' }) });
  for (let i = 0; i < 3; i++) {
    const l = await login(base);
    await face(base, l.json.pendingToken);
  }
  const rec = app.store.data.security.locked[USER.iin];
  assert.equal(rec.reason, 'face');
  assert.equal(rec.until, undefined);
  assert.equal((await login(base)).status, 423);
  assert.equal((await admin(base, 'POST', '/admin/unlock', { iin: USER.iin })).json.wasLocked, true);
  assert.equal((await login(base)).status, 200);
});

// ---------- параллельные проверки лица ----------

test('параллельные проверки лица по одному токену: прошла одна, остальные отклонены', async () => {
  const slow = {
    isDemo: true,
    async verify() {
      await new Promise((r) => setTimeout(r, 150));
      return 'match';
    },
  };
  const { base } = await start({ face: slow });
  const l = await login(base);
  const rs = await Promise.all([1, 2, 3, 4].map(() => face(base, l.json.pendingToken)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.filter((r) => r.status === 429).length, 3);
});

test('очередь проверок лица ограничена: лишние получают 503', async () => {
  const slow = {
    isDemo: true,
    async verify() {
      await new Promise((r) => setTimeout(r, 200));
      return 'noFace';
    },
  };
  const { base } = await start({ face: slow, maxFaceQueue: 2 });
  const tokens = [];
  for (let i = 0; i < 4; i++) tokens.push((await login(base)).json.pendingToken);
  const rs = await Promise.all(tokens.map((t) => face(base, t)));
  assert.equal(rs.filter((r) => r.status === 200).length, 2);
  assert.equal(rs.filter((r) => r.status === 503).length, 2);
});

// ---------- заказы: выдача, отмена, деньги ----------

async function order(base, token, productId = 'f1', qty = 2) {
  return call(base, 'POST', '/api/orders', { token, body: { items: [{ productId, qty }] } });
}

test('выдача заказа: один раз, потом код недействителен', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  const o = await order(base, token);
  assert.equal(o.status, 201);
  const code = o.json.order.code;
  const list = await admin(base, 'GET', '/admin/orders?status=ready');
  assert.equal(list.json.orders.length, 1);
  assert.equal(list.json.orders[0].iin.includes(USER.iin), false, 'ИИН в списке замаскирован');

  const p = await admin(base, 'POST', '/admin/orders/pickup', { code });
  assert.equal(p.json.order.status, 'picked_up');
  assert.equal((await admin(base, 'POST', '/admin/orders/pickup', { code })).status, 404);
  assert.equal((await admin(base, 'POST', '/admin/orders/cancel', { id: o.json.order.id })).status, 409);
  const mine = await call(base, 'GET', '/api/orders', { token });
  assert.equal(mine.json.orders[0].status, 'picked_up');
});

test('отмена заказа возвращает деньги и остатки, баланс сходится с журналом', async () => {
  const { base, app } = await start();
  const token = await fullLogin(base);
  const stock0 = app.store.data.products.find((p) => p.id === 'f1').stock;
  const o = await order(base, token, 'f1', 3);
  assert.equal(app.store.data.products.find((p) => p.id === 'f1').stock, stock0 - 3);

  const c = await admin(base, 'POST', '/admin/orders/cancel', { id: o.json.order.id });
  assert.equal(c.status, 200);
  assert.equal(c.json.balance, 25000);
  assert.equal(app.store.data.products.find((p) => p.id === 'f1').stock, stock0);
  assert.equal((await admin(base, 'POST', '/admin/orders/cancel', { id: o.json.order.id })).status, 409);

  const sum = app.store.data.ledger.filter((r) => r.iin === USER.iin).reduce((a, r) => a + r.amount, 0);
  assert.equal(sum, 0, 'заказ и возврат взаимно гасятся');
});

test('пополнение баланса дежурным: запись в журнале, защита от минуса', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  const t = await admin(base, 'POST', '/admin/balance', { iin: USER.iin, amount: 5000, note: 'выплата' });
  assert.equal(t.json.balance, 30000);
  assert.equal((await call(base, 'GET', '/api/me', { token })).json.balance, 30000);
  assert.equal((await admin(base, 'POST', '/admin/balance', { iin: USER.iin, amount: -999999 })).status, 409);
  assert.equal((await admin(base, 'POST', '/admin/balance', { iin: USER.iin, amount: 1.5 })).status, 400);
  assert.equal((await call(base, 'POST', '/admin/balance', { body: { iin: USER.iin, amount: 1 } })).status, 403);
  const l = await admin(base, 'GET', '/admin/ledger');
  assert.equal(l.json.ledger[0].type, 'topup');
  assert.equal(l.json.ledger[0].iin.includes(USER.iin), false);
});

test('повтор заказа по requestId после перезапуска не создаёт второй', async () => {
  const first = await start();
  const token = await fullLogin(first.base);
  const body = { requestId: 'req-1', items: [{ productId: 'f1', qty: 1 }] };
  const a = await call(first.base, 'POST', '/api/orders', { token, body });
  await first.app.close();
  const second = await createApp({ dbPath: first.dbPath, adminKey: ADMIN, rateLimitPerMin: 100000 });
  await new Promise((r) => second.server.listen(0, '127.0.0.1', r));
  cleanups.push(() => second.close());
  const base2 = `http://127.0.0.1:${second.server.address().port}`;
  const t2 = await fullLogin(base2);
  const b = await call(base2, 'POST', '/api/orders', { token: t2, body });
  assert.equal(b.status, 200);
  assert.equal(b.json.order.id, a.json.order.id);
  assert.equal(b.json.balance, 25000 - 650);
});

// ---------- хранилище ----------

test('с ключом шаблоны лиц в файле зашифрованы, с неверным ключом база не открывается', async () => {
  const { app, dbPath, dir } = await start({ secretKey: 'k1' });
  app.store.data.faceTemplates[USER.iin] = [Array.from({ length: 128 }, (_, i) => 0.123456 + i / 1000)];
  await app.store.save();
  const raw = fs.readFileSync(dbPath, 'utf8');
  assert.equal(raw.includes('0.123456'), false, 'числа шаблона не видны в файле');
  assert.ok(raw.includes('faceTemplatesEnc'));
  await app.close();

  const again = await createApp({ dbPath, adminKey: ADMIN, secretKey: 'k1' });
  assert.equal(again.store.data.faceTemplates[USER.iin][0].length, 128);
  await again.close();
  await assert.rejects(createApp({ dbPath, adminKey: ADMIN, secretKey: 'wrong' }));
  await assert.rejects(createApp({ dbPath, adminKey: ADMIN }), /DATA_KEY/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ключ можно включить на существующей открытой базе: она перезаписывается зашифрованной', async () => {
  const { app, dbPath } = await start();
  app.store.data.faceTemplates[USER.iin] = [[0.987654]];
  await app.store.save();
  await app.close();
  const enc = await createApp({ dbPath, adminKey: ADMIN, secretKey: 'k2' });
  await enc.close();
  assert.equal(fs.readFileSync(dbPath, 'utf8').includes('0.987654'), false);
});

test('резервная копия за день создаётся и хранится не больше 7', async () => {
  const { app, dbPath, dir } = await start();
  for (let d = 1; d <= 9; d++) fs.writeFileSync(`${dbPath}.bak-2020-01-0${d}`, '{}');
  app.store._backupDay = null;
  await app.store.save();
  const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
  assert.equal(baks.length, 7);
  assert.ok(baks.some((f) => f.endsWith(new Date().toISOString().slice(0, 10))));
});

test('много записей подряд не теряются и не ломают файл', async () => {
  const { app, dbPath } = await start();
  await Promise.all(
    Array.from({ length: 50 }, (_, i) => {
      app.store.data.favorites['x' + i] = ['f1'];
      return app.store.save();
    }),
  );
  const saved = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(Object.keys(saved.favorites).length, 50);
});

// ---------- сеть ----------

test('CORS по списку: чужой источник не получает разрешения', async () => {
  const { base } = await start({ corsOrigins: ['https://kiosk.example'] });
  const ok = await call(base, 'GET', '/health', { headers: { origin: 'https://kiosk.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://kiosk.example');
  const bad = await call(base, 'GET', '/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('лимит запросов за прокси считается по адресу, дописанному прокси', async () => {
  const { base } = await start({ rateLimitPerMin: 2, trustProxy: true });
  const send = (ip) =>
    call(base, 'POST', '/api/login', {
      body: { iin: USER.iin, pin: '0000' },
      headers: { 'x-forwarded-for': `1.1.1.1, ${ip}` },
    });
  await send('10.0.0.1');
  await send('10.0.0.1');
  assert.equal((await send('10.0.0.1')).status, 429);
  assert.equal((await send('10.0.0.2')).status, 401, 'другой терминал не пострадал');
});

test('слишком большое тело отклоняется сразу', async () => {
  const { base } = await start();
  const r = await call(base, 'POST', '/api/login', { body: { iin: USER.iin, pin: '1'.repeat(10000) } });
  assert.equal(r.status, 413);
});

// ---------- живость ----------

test('проверка живости: отказ или сбой не пускают, успех пропускает', async () => {
  const mk = (liveness) => {
    const v = new RealFaceVerifier({ liveness });
    v.extract = async () => ({ status: 'ok', descriptor: [0, 0] });
    return v;
  };
  const args = { image: Buffer.from('x'), templates: [[0, 0]] };
  assert.equal(await mk(null).verify(args), 'match');
  assert.equal(await mk({ check: async () => true }).verify(args), 'match');
  assert.equal(await mk({ check: async () => false }).verify(args), 'noMatch');
  assert.equal(
    await mk({
      check: async () => {
        throw new Error('x');
      },
    }).verify(args),
    'noMatch',
  );
  assert.equal(await mk({ check: async () => 'yes' }).verify(args), 'noMatch');
});

// ---------- панель дежурного ----------

test('панель дежурного отдаётся с защитными заголовками и не содержит данных', async () => {
  const { base } = await start();
  const r = await fetch(base + '/panel');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const html = await r.text();
  assert.ok(html.includes('панель дежурного'));
  assert.equal(html.includes(USER.iin), false);
});

test('в списке заказов для панели есть имя, ИИН замаскирован', async () => {
  const { base } = await start();
  const token = await fullLogin(base);
  await call(base, 'POST', '/api/orders', { token, body: { items: [{ productId: 'f1', qty: 1 }] } });
  const list = await admin(base, 'GET', '/admin/orders');
  assert.equal(list.json.orders[0].name, 'Серик Алимов');
  assert.equal(list.json.orders[0].iin.includes(USER.iin), false);
});

// ---------- история заказов ----------

test('история заказов привязана к владельцу: чужие заказы не видны', async () => {
  const { base } = await start();
  const other = { iin: '980107304562', pin: '4321' };
  const l2 = await call(base, 'POST', '/api/login', { body: other });
  const t2 = (await face(base, l2.json.pendingToken)).json.sessionToken;
  const t1 = await fullLogin(base);
  await order(base, t1, 'f1', 1);
  await order(base, t2, 'f8', 1);
  const mine = (await call(base, 'GET', '/api/orders', { token: t1 })).json.orders;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].items[0].productId, 'f1');
  assert.equal(mine[0].iin, undefined, 'ИИН в ответ не попадает');
  assert.equal((await call(base, 'GET', '/api/orders')).status, 401);
});

test('дежурный смотрит историю человека: все статусы, поиск, запись в журнал', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hist-'));
  const { base } = await start({ auditPath: path.join(dir, 'audit.log') });
  const token = await fullLogin(base);
  const a = await order(base, token, 'f1', 1);
  await order(base, token, 'f8', 1);
  await admin(base, 'POST', '/admin/orders/cancel', { id: a.json.order.id });

  const all = await admin(base, 'GET', `/admin/orders?status=all&iin=${USER.iin}`);
  assert.equal(all.json.orders.length, 2);
  assert.deepEqual(all.json.orders.map((o) => o.status).sort(), ['cancelled', 'ready']);
  assert.equal((await admin(base, 'GET', '/admin/orders?status=all&iin=123')).status, 400);
  assert.equal((await call(base, 'GET', `/admin/orders?status=all&iin=${USER.iin}`)).status, 403);

  const found = await admin(base, 'GET', '/admin/users?q=' + encodeURIComponent('серик'));
  assert.equal(found.json.users.length, 1);
  assert.equal(found.json.users[0].iin, USER.iin);
  assert.equal((await admin(base, 'GET', '/admin/users')).json.users.length, 2);

  const log = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  assert.ok(log.includes('admin_view_orders'));
  assert.equal(log.includes(USER.iin), false, 'ИИН в журнале замаскирован');
  fs.rmSync(dir, { recursive: true, force: true });
});
