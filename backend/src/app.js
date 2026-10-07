import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isValidIin, maskIin } from './iin.js';
import { verifyPin } from './pin.js';
import { Store } from './store.js';
import { DemoFaceVerifier } from './face.js';

const DEFAULTS = {
  /** Неверных ПИН подряд до блокировки аккаунта. */
  maxPinAttempts: 5,
  /** Неудачных проверок лица (без успешного входа между ними) до блокировки. */
  maxFaceAttempts: 3,
  maxFaceTemplates: 3,
  /** Сколько живёт шаг «ИИН+ПИН пройдены, ждём лицо». */
  pendingTtlMs: 2 * 60_000,
  /** Сеанс продлевается при каждом запросе; без запросов закрывается. */
  sessionTtlMs: 10 * 60_000,
  /** Лимит попыток входа с одного адреса в минуту. */
  rateLimitPerMin: 60,
  /** Сколько проверок лица может ждать очереди нейросети; остальные получают 503. */
  maxFaceQueue: 4,
  /** Блокировка по ПИН временная: первая на 15 минут, каждая следующая вдвое дольше, не больше суток. */
  pinLockBaseMs: 15 * 60_000,
  pinLockMaxMs: 24 * 60 * 60_000,
  /** Верить заголовку X-Forwarded-For (только если сервер стоит за своим прокси). */
  trustProxy: false,
  /** Разрешённые источники для CORS. null = любые (только для разработки). */
  corsOrigins: null,
  /** Необязательно: { key, cert } включает HTTPS. */
  tls: null,
};

const CORS_BASE = {
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
};

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

export async function createApp(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!cfg.dbPath) throw new Error('dbPath is required');
  if (!cfg.adminKey) throw new Error('adminKey is required');

  const face = cfg.face ?? new DemoFaceVerifier();
  const store = await Store.open(cfg.dbPath, { secretKey: cfg.secretKey });
  const db = () => store.data;

  const pending = new Map(); // pendingToken -> { iin, expires }
  const sessions = new Map(); // sessionToken -> { iin, expires }
  const hits = new Map(); // ip -> { count, resetAt }
  const faceBusy = new Set(); // pendingToken, по которым проверка лица уже идёт
  let faceInFlight = 0; // сколько проверок лица сейчас в работе или в очереди

  // Индексы заказов: без них каждый заказ перебирал бы всю историю.
  const orderByRequest = new Map(); // `${iin}:${requestId}` -> order
  const readyByCode = new Map(); // code -> order (только status 'ready')
  const orderById = new Map();
  for (const o of db().orders) {
    orderById.set(o.id, o);
    if (o.requestId) orderByRequest.set(`${o.iin}:${o.requestId}`, o);
    if (o.status === 'ready') readyByCode.set(o.code, o);
  }

  // ---------- вспомогательное ----------

  const token = () => crypto.randomBytes(24).toString('hex');

  function audit(ev, iin, extra = {}) {
    if (!cfg.auditPath) return;
    const rec = {
      t: new Date().toISOString(),
      ev,
      ...(iin ? { iin: maskIin(iin) } : {}),
      ...extra,
    };
    try {
      fs.appendFileSync(cfg.auditPath, JSON.stringify(rec) + '\n');
    } catch {
      /* журнал не должен ломать работу сервера */
    }
  }

  /** Заголовки CORS для этого запроса. Источник отражаем только если он в списке разрешённых. */
  function corsFor(req) {
    const list = cfg.corsOrigins;
    if (!list) return { ...CORS_BASE, 'Access-Control-Allow-Origin': '*' };
    const origin = req.headers.origin;
    const h = { ...CORS_BASE, Vary: 'Origin' };
    if (origin && list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
    return h;
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(cfg.tls ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
      ...(res.cors ?? {}),
    });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  function readJson(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          if (!tooBig) {
            tooBig = true;
            chunks.length = 0; // уже набранное выбрасываем, остальное не копим
            reject(new HttpError(413, 'payload_too_large'));
          }
        } else if (!tooBig) chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch {
          reject(new HttpError(400, 'invalid_json'));
        }
      });
      req.on('error', reject);
    });
  }

  function clientIp(req) {
    if (cfg.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      // Берём адрес, который дописал НАШ прокси (последний в списке); первые можно подделать.
      if (typeof fwd === 'string' && fwd) return fwd.split(',').pop().trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function rateLimit(req) {
    const ip = clientIp(req);
    const t = Date.now();
    let h = hits.get(ip);
    if (!h || h.resetAt <= t) {
      h = { count: 0, resetAt: t + 60_000 };
      hits.set(ip, h);
    }
    h.count++;
    if (h.count > cfg.rateLimitPerMin) throw new HttpError(429, 'too_many_requests');
  }

  /**
   * Блокировка по ПИН временная: ею нельзя навсегда «убить» чужой аккаунт, зная только ИИН.
   * Каждая следующая блокировка подряд вдвое дольше (15 мин, 30 мин, 1 ч ... до суток).
   * Блокировка по лицу (ПИН верен, а лицо чужое) остаётся жёсткой: снимает только дежурный.
   */
  function lockAccount(iin, reason) {
    const sec = db().security;
    const rec = { at: new Date().toISOString(), reason };
    if (reason === 'pin') {
      const strikes = (sec.strikes[iin] ?? 0) + 1;
      sec.strikes[iin] = strikes;
      const ms = Math.min(cfg.pinLockBaseMs * 2 ** (strikes - 1), cfg.pinLockMaxMs);
      rec.until = new Date(Date.now() + ms).toISOString();
    }
    sec.locked[iin] = rec;
    delete sec.pinFails[iin];
    audit('account_locked', iin, { reason, ...(rec.until ? { until: rec.until } : {}) });
  }

  /** Блокировка действует? Истёкшую временную блокировку снимаем (счётчик ПИН при этом чистый). */
  function isLocked(iin) {
    const rec = db().security.locked[iin];
    if (!rec) return false;
    if (rec.until && Date.parse(rec.until) <= Date.now()) {
      delete db().security.locked[iin];
      store.save().catch(() => {});
      audit('account_unlocked_auto', iin);
      return false;
    }
    return true;
  }

  const lockedBody = (iin) => {
    const until = db().security.locked[iin]?.until;
    const retryAfterSec = until ? Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000)) : undefined;
    return { status: 'locked', ...(retryAfterSec ? { retryAfterSec } : {}) };
  };

  function requireSession(req) {
    const m = /^Bearer ([0-9a-f]{48})$/.exec(req.headers.authorization ?? '');
    const s = m && sessions.get(m[1]);
    if (!s || s.expires <= Date.now() || !db().users[s.iin]) {
      if (m) sessions.delete(m[1]);
      throw new HttpError(401, 'session_expired');
    }
    s.expires = Date.now() + cfg.sessionTtlMs; // продлеваем
    return { ...s, token: m[1], user: db().users[s.iin] };
  }

  function requireAdmin(req) {
    const given = req.headers['x-admin-key'];
    if (typeof given !== 'string' || !crypto.timingSafeEqual(sha256(given), sha256(cfg.adminKey))) {
      throw new HttpError(403, 'forbidden');
    }
  }

  const publicOrder = (o) => ({
    id: o.id,
    code: o.code,
    total: o.total,
    status: o.status,
    createdAt: o.createdAt,
    items: o.items,
  });

  // ---------- вход ----------

  // Шаг 1–2: ИИН и ПИН. Успех = ещё НЕ вход, нужно пройти проверку лица.
  async function login(req, res) {
    rateLimit(req);
    const { iin, pin } = await readJson(req, 4096);
    if (!isValidIin(iin) || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      throw new HttpError(400, 'invalid_input');
    }
    const sec = db().security;

    // Заблокированный аккаунт не пускаем, даже с верным ПИН.
    if (isLocked(iin)) {
      audit('login_blocked', iin);
      return send(res, 423, lockedBody(iin));
    }

    const ok = await verifyPin(pin, db().users[iin]);

    // Пока считался хэш, аккаунт могли заблокировать параллельные попытки:
    // результат такой проверки уже не учитываем (иначе блокировку можно
    // обойти, отправив много запросов одновременно).
    if (isLocked(iin)) return send(res, 423, lockedBody(iin));

    if (ok) {
      delete sec.pinFails[iin];
      await store.save();
      const pendingToken = token();
      pending.set(pendingToken, { iin, expires: Date.now() + cfg.pendingTtlMs });
      audit('pin_ok', iin);
      return send(res, 200, {
        status: 'ok',
        pendingToken,
        faceAttemptsLeft: cfg.maxFaceAttempts - (sec.faceFails[iin] ?? 0),
        faceDemo: Boolean(face.isDemo),
      });
    }

    // Неизвестный ИИН считаем так же, как известный: иначе по ответам можно
    // было бы выяснить, какие ИИН существуют.
    const fails = (sec.pinFails[iin] ?? 0) + 1;
    sec.pinFails[iin] = fails;
    if (fails >= cfg.maxPinAttempts) {
      lockAccount(iin, 'pin');
      await store.save();
      return send(res, 423, lockedBody(iin));
    }
    await store.save();
    audit('pin_wrong', iin, { fails });
    return send(res, 401, { status: 'wrong', attemptsLeft: cfg.maxPinAttempts - fails });
  }

  // Шаг 3: лицо. Только здесь выдаётся сеанс.
  async function faceStep(req, res) {
    rateLimit(req);
    const body = await readJson(req, 3 * 1024 * 1024);
    const p = typeof body.pendingToken === 'string' ? pending.get(body.pendingToken) : null;
    if (!p || p.expires <= Date.now()) {
      if (p) pending.delete(body.pendingToken);
      throw new HttpError(401, 'session_expired');
    }
    const iin = p.iin;
    const sec = db().security;
    if (isLocked(iin)) {
      pending.delete(body.pendingToken);
      return send(res, 423, { result: 'locked', locked: true });
    }
    if (typeof body.image !== 'string' || body.image.length === 0) {
      throw new HttpError(400, 'invalid_input');
    }

    // Одна проверка на один шаг: параллельные запросы с тем же токеном не должны
    // читать один и тот же счётчик неудач и тем обходить блокировку.
    if (faceBusy.has(body.pendingToken)) throw new HttpError(429, 'face_check_in_progress');
    // Нейросеть работает по очереди; длинную очередь не копим, чтобы сервер нельзя было завалить снимками.
    if (faceInFlight >= cfg.maxFaceQueue) throw new HttpError(503, 'busy', { retryAfterSec: 2 });
    faceBusy.add(body.pendingToken);
    faceInFlight++;

    let result;
    try {
      // Снимок живёт только в памяти на время проверки и нигде не сохраняется.
      result = await face.verify({
        iin,
        image: Buffer.from(body.image, 'base64'),
        templates: db().faceTemplates[iin] ?? [],
      });
    } catch {
      result = 'error';
    } finally {
      faceBusy.delete(body.pendingToken);
      faceInFlight--;
    }

    // Пока шла проверка, шаг могли отменить или аккаунт заблокировать.
    if (!pending.has(body.pendingToken)) throw new HttpError(401, 'session_expired');
    if (isLocked(iin)) {
      pending.delete(body.pendingToken);
      return send(res, 423, { result: 'locked', locked: true });
    }

    if (result === 'match') {
      delete sec.faceFails[iin];
      delete sec.strikes[iin]; // полный успешный вход: «штрафная история» блокировок обнуляется
      pending.delete(body.pendingToken); // до await: второй запрос с этим токеном уже не пройдёт
      await store.save();
      const sessionToken = token();
      sessions.set(sessionToken, { iin, expires: Date.now() + cfg.sessionTtlMs });
      const user = db().users[iin];
      audit('login_ok', iin);
      return send(res, 200, {
        result: 'match',
        sessionToken,
        user: { name: user.name, unit: user.unit },
        balance: user.balance,
        favorites: db().favorites[iin] ?? [],
      });
    }

    if (result === 'noMatch') {
      // Верные ИИН и ПИН, но чужое лицо: возможна кража аккаунта.
      // Счётчик не обнуляется новым входом, ПИН нельзя пробовать с лицом бесконечно.
      const fails = (sec.faceFails[iin] ?? 0) + 1;
      sec.faceFails[iin] = fails;
      if (fails >= cfg.maxFaceAttempts) {
        lockAccount(iin, 'face');
        pending.delete(body.pendingToken);
        await store.save();
        return send(res, 423, { result: 'noMatch', locked: true });
      }
      await store.save();
      audit('face_fail', iin, { fails });
      return send(res, 200, { result: 'noMatch', attemptsLeft: cfg.maxFaceAttempts - fails });
    }

    // noFace / error не считаются попыткой (плохой свет, сбой камеры).
    const safe = result === 'noFace' ? 'noFace' : 'error';
    return send(res, 200, {
      result: safe,
      attemptsLeft: cfg.maxFaceAttempts - (sec.faceFails[iin] ?? 0),
    });
  }

  // ---------- каталог, избранное, заказы ----------

  async function setFavorite(session, productId, value) {
    if (!db().products.some((p) => p.id === productId)) {
      throw new HttpError(404, 'unknown_product');
    }
    const set = new Set(db().favorites[session.iin] ?? []);
    if (value) set.add(productId);
    else set.delete(productId);
    db().favorites[session.iin] = [...set];
    await store.save();
    return { favorites: db().favorites[session.iin] };
  }

  function newOrderCode() {
    for (let i = 0; i < 50; i++) {
      const c = String(crypto.randomInt(100000, 1000000));
      if (!readyByCode.has(c)) return c;
    }
    throw new HttpError(503, 'try_again');
  }

  /** Запись в журнал денежных операций: что, кому, на сколько и какой остаток. */
  function ledger(iin, type, amount, balance, extra = {}) {
    db().ledger.push({ t: new Date().toISOString(), iin, type, amount, balance, ...extra });
  }

  /** Меняет баланс и пишет операцию. Вызывать синхронно вместе с остальными изменениями. */
  function applyBalance(user, delta, type, extra) {
    user.balance += delta;
    ledger(user.iin, type, delta, user.balance, extra);
  }

  function placeOrder(session, body) {
    const { user, iin } = session;

    // Повтор того же запроса (например, после обрыва связи) не списывает деньги дважды.
    const requestId =
      typeof body.requestId === 'string' && body.requestId.length > 0 && body.requestId.length <= 64
        ? body.requestId
        : null;
    if (requestId) {
      const prev = orderByRequest.get(`${iin}:${requestId}`);
      if (prev) return { order: publicOrder(prev), balance: user.balance, replay: true };
    }

    const items = body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
      throw new HttpError(400, 'invalid_items');
    }
    const merged = new Map();
    for (const it of items) {
      if (
        !it ||
        typeof it.productId !== 'string' ||
        !Number.isInteger(it.qty) ||
        it.qty < 1 ||
        it.qty > 99
      ) {
        throw new HttpError(400, 'invalid_items');
      }
      merged.set(it.productId, (merged.get(it.productId) ?? 0) + it.qty);
    }

    // Цены и остатки берём только с сервера, от клиента принимаем лишь «что и сколько».
    let total = 0;
    const lines = [];
    for (const [productId, qty] of merged) {
      const product = db().products.find((p) => p.id === productId);
      if (!product) throw new HttpError(400, 'unknown_product', { productId });
      if (product.stock < qty) {
        throw new HttpError(409, 'out_of_stock', { productId, available: product.stock });
      }
      total += product.price * qty;
      lines.push({ product, qty });
    }
    if (total > user.balance) {
      throw new HttpError(409, 'insufficient_funds', { balance: user.balance, total });
    }

    // Проверки пройдены, дальше всё синхронно, без await: заказ применяется целиком.
    for (const { product, qty } of lines) product.stock -= qty;
    const orderId = crypto.randomUUID();
    applyBalance(user, -total, 'order', { orderId });
    const order = {
      id: orderId,
      iin,
      requestId,
      code: newOrderCode(),
      status: 'ready', // ready -> picked_up | cancelled
      total,
      createdAt: new Date().toISOString(),
      items: lines.map(({ product, qty }) => ({
        productId: product.id,
        nameRu: product.nameRu,
        nameKk: product.nameKk,
        price: product.price,
        qty,
      })),
    };
    db().orders.push(order);
    orderById.set(order.id, order);
    if (requestId) orderByRequest.set(`${iin}:${requestId}`, order);
    readyByCode.set(order.code, order);
    audit('order', iin, { total, items: lines.length });
    return { order: publicOrder(order), balance: user.balance, replay: false };
  }

  // ---------- маршрутизация ----------

  const enrollPage = fs.readFileSync(new URL('../public/enroll.html', import.meta.url));
  const panelPage = fs.readFileSync(new URL('../public/admin.html', import.meta.url));

  const ORDER_STATUSES = new Set(['ready', 'picked_up', 'cancelled']);
  const adminOrder = (o) => ({ ...publicOrder(o), iin: maskIin(o.iin), name: db().users[o.iin]?.name });

  /** Находит заказ по id или по 6-значному коду выдачи (код ищем только среди готовых). */
  function findOrder({ id, code }) {
    if (typeof id === 'string' && orderById.has(id)) return orderById.get(id);
    if (typeof code === 'string' && readyByCode.has(code)) return readyByCode.get(code);
    throw new HttpError(404, 'unknown_order');
  }

  /** Выдача заказа солдату. Повторная выдача невозможна. */
  async function pickupOrder(body) {
    const o = findOrder(body);
    if (o.status !== 'ready') throw new HttpError(409, 'order_not_ready', { status: o.status });
    o.status = 'picked_up';
    o.pickedUpAt = new Date().toISOString();
    readyByCode.delete(o.code);
    await store.save();
    audit('order_picked_up', o.iin, { total: o.total });
    return { order: adminOrder(o) };
  }

  /** Отмена заказа до выдачи: деньги возвращаются, остатки товаров тоже. */
  async function cancelOrder(body) {
    const o = findOrder(body);
    if (o.status !== 'ready') throw new HttpError(409, 'order_not_ready', { status: o.status });
    const user = db().users[o.iin];
    o.status = 'cancelled';
    o.cancelledAt = new Date().toISOString();
    readyByCode.delete(o.code);
    for (const it of o.items) {
      const product = db().products.find((p) => p.id === it.productId);
      if (product) product.stock += it.qty;
    }
    if (user) applyBalance(user, o.total, 'refund', { orderId: o.id });
    await store.save();
    audit('order_cancelled', o.iin, { total: o.total });
    return { order: adminOrder(o), balance: user?.balance };
  }

  /** Пополнение (или списание при отрицательной сумме) баланса дежурным. */
  async function adjustBalance(body) {
    const { iin, amount, note } = body;
    const user = isValidIin(iin) ? db().users[iin] : null;
    if (!user) throw new HttpError(404, 'unknown_user');
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
      throw new HttpError(400, 'invalid_amount');
    }
    if (user.balance + amount < 0) throw new HttpError(409, 'insufficient_funds', { balance: user.balance });
    applyBalance(user, amount, amount > 0 ? 'topup' : 'debit', {
      ...(typeof note === 'string' && note ? { note: note.slice(0, 200) } : {}),
    });
    await store.save();
    audit('balance_adjusted', iin, { amount });
    return { balance: user.balance };
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;

    if (m === 'OPTIONS') {
      res.writeHead(204, res.cors);
      return res.end();
    }
    if (m === 'GET' && p === '/health') return send(res, 200, { ok: true });
    if (m === 'GET' && p === '/enroll') {
      // Страница регистрации лица. Сама по себе безвредна: всё делают запросы /admin/* с ключом.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(enrollPage);
    }

    if (m === 'GET' && p === '/panel') {
      // Панель дежурного. Страница сама по себе без секретов, все данные идут запросами /admin/* с ключом.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      return res.end(panelPage);
    }

    if (m === 'POST' && p === '/api/login') return login(req, res);
    if (m === 'POST' && p === '/api/face') return faceStep(req, res);

    if (p.startsWith('/admin/')) {
      requireAdmin(req);
      if (m === 'GET' && p === '/admin/locked') {
        const list = Object.entries(db().security.locked).map(([iin, v]) => ({ iin, ...v }));
        return send(res, 200, { locked: list });
      }
      if (m === 'POST' && p === '/admin/unlock') {
        const { iin } = await readJson(req, 4096);
        if (!isValidIin(iin)) throw new HttpError(400, 'invalid_input');
        const wasLocked = isLocked(iin);
        delete db().security.locked[iin];
        delete db().security.pinFails[iin];
        delete db().security.faceFails[iin];
        delete db().security.strikes[iin];
        await store.save();
        audit('account_unlocked', iin);
        return send(res, 200, { ok: true, wasLocked });
      }
      if (m === 'POST' && p === '/admin/enroll') {
        // Регистрация эталона лица: сервер сохраняет только числовой шаблон, снимок выбрасывается.
        if (typeof face.extract !== 'function') throw new HttpError(501, 'face_demo_mode');
        const body = await readJson(req, 3 * 1024 * 1024);
        if (!isValidIin(body.iin) || !db().users[body.iin]) throw new HttpError(404, 'unknown_user');
        if (typeof body.image !== 'string' || body.image.length === 0) {
          throw new HttpError(400, 'invalid_input');
        }
        const r = await face.extract(Buffer.from(body.image, 'base64'));
        if (r.status !== 'ok') throw new HttpError(422, 'face_' + r.status);
        const list = body.replace === true ? [] : [...(db().faceTemplates[body.iin] ?? [])];
        list.push(r.descriptor);
        db().faceTemplates[body.iin] = list.slice(-cfg.maxFaceTemplates);
        await store.save();
        audit('face_enrolled', body.iin, { templates: db().faceTemplates[body.iin].length });
        return send(res, 200, { ok: true, templates: db().faceTemplates[body.iin].length });
      }
      if (m === 'GET' && p === '/admin/orders') {
        const status = url.searchParams.get('status') ?? 'ready';
        if (!ORDER_STATUSES.has(status)) throw new HttpError(400, 'invalid_status');
        const list = db().orders.filter((o) => o.status === status).slice(-200).reverse().map(adminOrder);
        return send(res, 200, { orders: list });
      }
      if (m === 'POST' && p === '/admin/orders/pickup') {
        return send(res, 200, await pickupOrder(await readJson(req, 4096)));
      }
      if (m === 'POST' && p === '/admin/orders/cancel') {
        return send(res, 200, await cancelOrder(await readJson(req, 4096)));
      }
      if (m === 'POST' && p === '/admin/balance') {
        return send(res, 200, await adjustBalance(await readJson(req, 4096)));
      }
      if (m === 'GET' && p === '/admin/ledger') {
        const iin = url.searchParams.get('iin');
        const rows = db().ledger.filter((r) => !iin || r.iin === iin).slice(-200).reverse()
          .map((r) => ({ ...r, iin: maskIin(r.iin) }));
        return send(res, 200, { ledger: rows });
      }
      if (m === 'GET' && p === '/admin/enrolled') {
        const out = Object.keys(db().users).map((iin) => ({
          iin: maskIin(iin),
          name: db().users[iin].name,
          templates: (db().faceTemplates[iin] ?? []).length,
        }));
        return send(res, 200, { users: out });
      }
      if (m === 'POST' && p === '/admin/unenroll') {
        const { iin } = await readJson(req, 4096);
        if (!isValidIin(iin)) throw new HttpError(400, 'invalid_input');
        delete db().faceTemplates[iin];
        await store.save();
        audit('face_unenrolled', iin);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, 'not_found');
    }

    if (p.startsWith('/api/')) {
      const session = requireSession(req);

      if (m === 'GET' && p === '/api/catalog') {
        return send(res, 200, { products: db().products });
      }
      if (m === 'GET' && p === '/api/me') {
        return send(res, 200, {
          user: { name: session.user.name, unit: session.user.unit },
          balance: session.user.balance,
          favorites: db().favorites[session.iin] ?? [],
        });
      }
      const fav = /^\/api\/favorites\/([A-Za-z0-9_-]{1,32})$/.exec(p);
      if (fav && (m === 'PUT' || m === 'DELETE')) {
        return send(res, 200, await setFavorite(session, fav[1], m === 'PUT'));
      }
      if (m === 'GET' && p === '/api/orders') {
        const mine = db()
          .orders.filter((o) => o.iin === session.iin)
          .slice(-50)
          .reverse()
          .map(publicOrder);
        return send(res, 200, { orders: mine });
      }
      if (m === 'POST' && p === '/api/orders') {
        const body = await readJson(req, 16 * 1024);
        const result = placeOrder(session, body);
        // Подтверждаем заказ только когда он записан на диск: иначе после сбоя деньги списаны, а заказа нет.
        if (!result.replay) await store.save();
        return send(res, result.replay ? 200 : 201, result);
      }
      if (m === 'POST' && p === '/api/logout') {
        sessions.delete(session.token);
        audit('logout', session.iin);
        return send(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, 'not_found');
  }

  const handler = async (req, res) => {
    res.cors = corsFor(req);
    try {
      await route(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) send(res, e.status, { error: e.code, ...e.extra });
        // Слишком большое тело: не читаем остаток, закрываем соединение после ответа.
        if (e.status === 413) res.once('finish', () => req.destroy());
        return;
      }
      console.error('Ошибка сервера:', e?.message ?? e);
      if (!res.headersSent) send(res, 500, { error: 'server_error' });
    }
  };
  const server = cfg.tls ? https.createServer(cfg.tls, handler) : http.createServer(handler);

  // Чистим просроченные сеансы и счётчики запросов.
  const gc = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of pending) if (v.expires <= t) pending.delete(k);
    for (const [k, v] of sessions) if (v.expires <= t) sessions.delete(k);
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, 60_000);
  gc.unref();

  return {
    server,
    store,
    async close() {
      clearInterval(gc);
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await store.flush(); // дописываем всё, что ещё не на диске
    },
  };
}
