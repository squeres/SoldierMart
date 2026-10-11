import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { RealFaceVerifier } from '../src/face-real.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const img = (n) => fs.readFileSync(path.join(here, 'faces', n));
const b64 = (n) => img(n).toString('base64');

const USER = { iin: '030515501234', pin: '1234' };
const OTHER = { iin: '980107304562', pin: '4321' };
const ADMIN = 'test-admin-key';

let verifier;
const cleanups = [];
before(async () => {
  verifier = await new RealFaceVerifier().init();
});
after(async () => {
  for (const fn of cleanups) await fn();
});

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-face-'));
  const app = await createApp({
    adminKey: ADMIN,
    rateLimitPerMin: 100000,
    face: verifier,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  cleanups.push(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base, app };
}

async function call(base, method, url, { body, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (admin) headers['x-admin-key'] = admin;
  const r = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, json, text };
}

const enroll = (base, iin, file, extra = {}) =>
  call(base, 'POST', '/admin/enroll', {
    admin: ADMIN,
    body: { iin, image: b64(file), ...extra },
  });

async function faceAttempt(base, u, file) {
  const l = await call(base, 'POST', '/api/login', { body: { iin: u.iin, pin: u.pin } });
  assert.equal(l.status, 200);
  return call(base, 'POST', '/api/face', {
    body: { pendingToken: l.json.pendingToken, image: b64(file) },
  });
}

// ---------- сам распознаватель ----------

test('снимок без лица, слишком маленькое лицо и несколько лиц не дают шаблона', async () => {
  assert.equal((await verifier.extract(img('noface.jpg'))).status, 'noFace');
  assert.equal((await verifier.extract(img('tiny.jpg'))).status, 'noFace');
  assert.equal((await verifier.extract(img('two.jpg'))).status, 'multiple');
});

test('мусор вместо картинки не роняет сервер', async () => {
  assert.equal((await verifier.extract(Buffer.from('not an image'))).status, 'badImage');
  assert.equal((await verifier.extract(Buffer.alloc(0))).status, 'badImage');
  // Обрезанный JPEG
  assert.equal((await verifier.extract(img('s1_0.jpg').subarray(0, 300))).status, 'badImage');
});

test('тот же человек на другом снимке узнаётся, другой человек нет', async () => {
  const a = await verifier.extract(img('s1_0.jpg'));
  assert.equal(a.status, 'ok');
  assert.equal(a.descriptor.length, 128);
  assert.equal(await verifier.verify({ image: img('v_s1_0.jpg'), templates: [a.descriptor] }), 'match');
  assert.equal(await verifier.verify({ image: img('s6_3.jpg'), templates: [a.descriptor] }), 'noMatch');
  assert.equal(await verifier.verify({ image: img('s6_0.jpg'), templates: [a.descriptor] }), 'noMatch');
});

test('без эталона, с битым эталоном или без лица на снимке входа нет', async () => {
  const a = await verifier.extract(img('s1_0.jpg'));
  assert.equal(await verifier.verify({ image: img('s1_0.jpg'), templates: [] }), 'error');
  assert.equal(await verifier.verify({ image: img('s1_0.jpg'), templates: undefined }), 'error');
  assert.equal(await verifier.verify({ image: img('s1_0.jpg'), templates: [[1, 2, 3]] }), 'noMatch');
  assert.equal(await verifier.verify({ image: img('noface.jpg'), templates: [a.descriptor] }), 'noFace');
  assert.equal(await verifier.verify({ image: img('two.jpg'), templates: [a.descriptor] }), 'error');
});

test('одновременные проверки обрабатываются по очереди и дают верные ответы', async () => {
  const a = await verifier.extract(img('s1_0.jpg'));
  const r = await Promise.all([
    verifier.verify({ image: img('v_s1_0.jpg'), templates: [a.descriptor] }),
    verifier.verify({ image: img('s6_3.jpg'), templates: [a.descriptor] }),
    verifier.verify({ image: img('v_s1_0.jpg'), templates: [a.descriptor] }),
  ]);
  assert.deepEqual(r, ['match', 'noMatch', 'match']);
});

// ---------- через API ----------

test('регистрация лица требует ключ дежурного', async () => {
  const { base } = await start();
  const r = await call(base, 'POST', '/admin/enroll', {
    body: { iin: USER.iin, image: b64('s1_0.jpg') },
  });
  assert.equal(r.status, 403);
  const bad = await call(base, 'POST', '/admin/enroll', {
    admin: 'wrong',
    body: { iin: USER.iin, image: b64('s1_0.jpg') },
  });
  assert.equal(bad.status, 403);
});

test('регистрация: плохие снимки и неизвестный ИИН отклоняются', async () => {
  const { base } = await start();
  assert.equal((await enroll(base, USER.iin, 'noface.jpg')).status, 422);
  assert.equal((await enroll(base, USER.iin, 'two.jpg')).json.error, 'face_multiple');
  assert.equal((await enroll(base, '111111111111', 's1_0.jpg')).status, 404);
  const none = await call(base, 'GET', '/admin/enrolled', { admin: ADMIN });
  assert.ok(none.json.users.every((u) => u.templates === 0));
});

test('вход по лицу: свой проходит, чужой нет, три чужих блокируют аккаунт', async () => {
  const { base } = await start();
  const e = await enroll(base, USER.iin, 's1_0.jpg');
  assert.equal(e.status, 200);
  assert.equal(e.json.templates, 1);

  const ok = await faceAttempt(base, USER, 'v_s1_0.jpg');
  assert.equal(ok.json.result, 'match');
  assert.ok(ok.json.sessionToken);

  const f1 = await faceAttempt(base, USER, 's6_3.jpg');
  assert.equal(f1.json.result, 'noMatch');
  assert.equal(f1.json.attemptsLeft, 2);
  const f2 = await faceAttempt(base, USER, 's6_0.jpg');
  assert.equal(f2.json.attemptsLeft, 1);
  const f3 = await faceAttempt(base, USER, 's6_3.jpg');
  assert.equal(f3.status, 423);

  // Заблокирован: даже со своим лицом и верным ПИН не войти.
  const again = await call(base, 'POST', '/api/login', { body: { iin: USER.iin, pin: USER.pin } });
  assert.equal(again.status, 423);
});

test('у кого эталона нет, войти нельзя, но попытки не сгорают', async () => {
  const { base } = await start();
  for (let i = 0; i < 5; i++) {
    const r = await faceAttempt(base, OTHER, 's1_0.jpg');
    assert.equal(r.status, 200);
    assert.equal(r.json.result, 'error');
    assert.equal(r.json.sessionToken, undefined);
  }
  const l = await call(base, 'POST', '/api/login', { body: { iin: OTHER.iin, pin: OTHER.pin } });
  assert.equal(l.status, 200); // не заблокирован
});

test('эталон одного человека не открывает аккаунт другого', async () => {
  const { base } = await start();
  await enroll(base, USER.iin, 's1_0.jpg');
  await enroll(base, OTHER.iin, 's6_3.jpg');
  assert.equal((await faceAttempt(base, USER, 'v_s1_0.jpg')).json.result, 'match');
  assert.equal((await faceAttempt(base, OTHER, 'v_s6_3.jpg')).json.result, 'match');
  assert.equal((await faceAttempt(base, OTHER, 's1_0.jpg')).json.result, 'noMatch');
});

test('несколько снимков в эталоне, replace заменяет, максимум 3', async () => {
  const { base } = await start();
  await enroll(base, USER.iin, 's1_0.jpg');
  assert.equal((await enroll(base, USER.iin, 'v_s1_0.jpg')).json.templates, 2);
  await enroll(base, USER.iin, 's1_0.jpg');
  assert.equal((await enroll(base, USER.iin, 'v_s1_0.jpg')).json.templates, 3);
  assert.equal((await enroll(base, USER.iin, 's6_3.jpg', { replace: true })).json.templates, 1);
  // После замены прежнее лицо уже не подходит.
  assert.equal((await faceAttempt(base, USER, 'v_s1_0.jpg')).json.result, 'noMatch');
});

test('удаление эталона закрывает вход по лицу', async () => {
  const { base } = await start();
  await enroll(base, USER.iin, 's1_0.jpg');
  await call(base, 'POST', '/admin/unenroll', { admin: ADMIN, body: { iin: USER.iin } });
  assert.equal((await faceAttempt(base, USER, 's1_0.jpg')).json.result, 'error');
});

test('в базе только числа: снимок не сохраняется, ИИН в списке замаскирован', async () => {
  const { base, app } = await start();
  await enroll(base, USER.iin, 's1_0.jpg');
  const { rows } = await app.db.query('SELECT descriptor FROM face_templates WHERE iin = $1', [USER.iin]);
  assert.equal(rows.length, 1);
  const raw = rows[0].descriptor;
  const vec = JSON.parse(raw);
  assert.equal(vec.length, 128);
  assert.ok(vec.every((x) => typeof x === 'number'));
  assert.ok(!raw.includes(b64('s1_0.jpg').slice(0, 200)));
  assert.ok(raw.length < 5_000);

  const list = await call(base, 'GET', '/admin/enrolled', { admin: ADMIN });
  assert.ok(!list.text.includes(USER.iin));
  assert.equal(list.json.users.filter((u) => u.templates > 0).length, 1);
});

test('шаблоны переживают перезапуск сервера', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-face-r-'));
  const opts = { dataDir: dir, adminKey: ADMIN, rateLimitPerMin: 100000, face: verifier };
  const run = async (fn) => {
    const app = await createApp(opts);
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    try {
      await fn(`http://127.0.0.1:${app.server.address().port}`);
    } finally {
      await app.close();
    }
  };
  await run((b) => enroll(b, USER.iin, 's1_0.jpg'));
  await run(async (b) => {
    assert.equal((await faceAttempt(b, USER, 'v_s1_0.jpg')).json.result, 'match');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('страница регистрации отдаётся, в демо-режиме регистрация отключена', async () => {
  const { base } = await start();
  const page = await call(base, 'GET', '/enroll');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Регистрация лица'));

  const app = await createApp({ adminKey: ADMIN });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${app.server.address().port}`;
  const r = await enroll(b, USER.iin, 's1_0.jpg');
  assert.equal(r.status, 501);
  await app.close();
});
