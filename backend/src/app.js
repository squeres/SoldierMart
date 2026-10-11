import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isValidIin, maskIin } from './iin.js';
import { verifyPin } from './pin.js';
import { openDb } from './db.js';
import { createRepo, RepoError } from './repo.js';
import { seedDatabase } from './seed.js';
import { toKey } from './secret.js';
import { CATEGORIES, ICONS } from './catalog-meta.js';
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
  /** Лимит попыток входа с одного адреса в минуту (считается в памяти каждого сервера). */
  rateLimitPerMin: 60,
  /** Сколько проверок лица может ждать очереди нейросети на этом сервере; остальные получают 503. */
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
  /** Добавить демо-пользователей в пустую базу (в боевой базе должно быть false). */
  seedDemoUsers: true,
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

/** Как ошибки слоя данных выглядят для клиента. */
const REPO_STATUS = {
  unknown_product: 400,
  unknown_user: 404,
  unknown_order: 404,
  order_not_ready: 409,
  out_of_stock: 409,
  insufficient_funds: 409,
  try_again: 503,
  product_exists: 409,
  insufficient_stock: 409,
  product_in_active_orders: 409,
  invalid_value: 400,
  nothing_to_update: 400,
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/**
 * @param {object} options
 *  База: `db` (уже открытая) или `databaseUrl` (PostgreSQL) или `dataDir` (встроенная в папке);
 *  без всего этого база встроенная и временная, в памяти (тесты).
 */
export async function createApp(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!cfg.adminKey) throw new Error('adminKey is required');

  const face = cfg.face ?? new DemoFaceVerifier();
  const ownsDb = !cfg.db;
  const db = cfg.db ?? (await openDb({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir }));
  const repo = createRepo(db, { secretKey: toKey(cfg.secretKey) });
  try {
    await repo.reconcileEncryption();
    await seedDatabase(db, repo, { demoUsers: cfg.seedDemoUsers });
  } catch (e) {
    if (ownsDb) await db.close();
    throw e;
  }

  const hits = new Map(); // ip -> { count, resetAt }
  let faceInFlight = 0; // сколько проверок лица сейчас в работе или в очереди на этом сервере

  // ---------- вспомогательное ----------

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

  /** Тело ответа «аккаунт заблокирован»; у временной блокировки есть время до разблокировки. */
  const lockedBody = (until) => {
    const sec = until ? Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000)) : undefined;
    return { status: 'locked', ...(sec ? { retryAfterSec: sec } : {}) };
  };

  async function requireSession(req) {
    const m = /^Bearer ([0-9a-f]{48})$/.exec(req.headers.authorization ?? '');
    const user = m ? await repo.touchSession(m[1], cfg.sessionTtlMs) : null; // заодно продлевает сеанс
    if (!user) throw new HttpError(401, 'session_expired');
    return { iin: user.iin, token: m[1], user };
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
    ...(o.pickedUpAt ? { pickedUpAt: o.pickedUpAt } : {}),
    ...(o.cancelledAt ? { cancelledAt: o.cancelledAt } : {}),
    items: o.items,
  });
  const adminOrder = (o) => ({ ...publicOrder(o), iin: maskIin(o.iin), name: o.userName });

  /** Ошибки слоя данных -> HTTP. `overrides` меняет статус для отдельных кодов. */
  async function guard(fn, overrides = {}) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RepoError) {
        throw new HttpError(overrides[e.code] ?? REPO_STATUS[e.code] ?? 500, e.code, e.extra);
      }
      throw e;
    }
  }

  // ---------- товары (для дежурного) ----------

  const INT_FIELDS = { price: [0, 10_000_000], stock: [0, 1_000_000] };

  /** Проверка полей товара. Лишние поля отбрасываются; при ошибке — 400 с названием поля. */
  function parseProduct(body, { create }) {
    const out = {};
    const bad = (field) => new HttpError(400, 'invalid_product', { field });
    const name = (v, field) => {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t.length < 1 || t.length > 120) throw bad(field);
      return t;
    };
    if (body.nameRu !== undefined || create) out.nameRu = name(body.nameRu, 'nameRu');
    if (body.nameKk !== undefined) out.nameKk = name(body.nameKk, 'nameKk');
    if (create && out.nameKk === undefined) out.nameKk = out.nameRu; // нет казахского названия — берём русское
    if (body.category !== undefined || create) {
      if (!CATEGORIES.some((c) => c.id === body.category)) throw bad('category');
      out.category = body.category;
    }
    if (body.icon !== undefined || create) {
      const icon = body.icon ?? 'shopping_bag';
      if (!ICONS.includes(icon)) throw bad('icon');
      out.icon = icon;
    }
    for (const [k, [lo, hi]] of Object.entries(INT_FIELDS)) {
      if (body[k] === undefined && !create) continue;
      const v = body[k] ?? (k === 'stock' ? 0 : undefined);
      if (!Number.isInteger(v) || v < lo || v > hi) throw bad(k);
      out[k] = v;
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw bad('active');
      out.active = body.active;
    }
    if (create && body.id !== undefined) {
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(body.id)) throw bad('id');
      out.id = body.id;
    }
    return out;
  }

  // ---------- вход ----------

  // Шаг 1–2: ИИН и ПИН. Успех = ещё НЕ вход, нужно пройти проверку лица.
  async function login(req, res) {
    rateLimit(req);
    const { iin, pin } = await readJson(req, 4096);
    if (!isValidIin(iin) || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      throw new HttpError(400, 'invalid_input');
    }

    // Заблокированный аккаунт не пускаем, даже с верным ПИН.
    const sec = await repo.getSecurity(iin);
    if (sec.locked) {
      audit('login_blocked', iin);
      return send(res, 423, lockedBody(sec.until));
    }

    const ok = await verifyPin(pin, await repo.getUser(iin));

    if (ok) {
      // Пока считался хэш, аккаунт могли заблокировать параллельные попытки:
      // результат такой проверки уже не учитываем (иначе блокировку можно
      // обойти, отправив много запросов одновременно).
      const again = await repo.getSecurity(iin);
      if (again.locked) return send(res, 423, lockedBody(again.until));
      await repo.resetPinFails(iin);
      const pendingToken = await repo.createPending(iin, cfg.pendingTtlMs);
      audit('pin_ok', iin);
      return send(res, 200, {
        status: 'ok',
        pendingToken,
        faceAttemptsLeft: cfg.maxFaceAttempts - again.faceFails,
        faceDemo: Boolean(face.isDemo),
      });
    }

    // Неизвестный ИИН считаем так же, как известный: иначе по ответам можно
    // было бы выяснить, какие ИИН существуют.
    const r = await repo.registerPinFail(iin, {
      max: cfg.maxPinAttempts,
      baseMs: cfg.pinLockBaseMs,
      maxMs: cfg.pinLockMaxMs,
    });
    if (r.locked) {
      if (!r.already) audit('account_locked', iin, { reason: 'pin', until: r.until });
      return send(res, 423, lockedBody(r.until));
    }
    audit('pin_wrong', iin, { fails: r.fails });
    return send(res, 401, { status: 'wrong', attemptsLeft: cfg.maxPinAttempts - r.fails });
  }

  // Шаг 3: лицо. Только здесь выдаётся сеанс.
  async function faceStep(req, res) {
    rateLimit(req);
    const body = await readJson(req, 3 * 1024 * 1024);
    const pendingToken =
      typeof body.pendingToken === 'string' && /^[0-9a-f]{48}$/.test(body.pendingToken)
        ? body.pendingToken
        : null;
    if (!pendingToken) throw new HttpError(401, 'session_expired');

    // Одна проверка на один шаг входа: шаг занимается атомарно (в базе), поэтому параллельные
    // запросы с тем же токеном, даже на разных серверах, не могут читать один счётчик неудач.
    const claim = await repo.claimPending(pendingToken);
    if (claim.state === 'busy') throw new HttpError(429, 'face_check_in_progress');
    if (claim.state === 'missing') throw new HttpError(401, 'session_expired');
    const iin = claim.iin;

    let consumed = false; // токен шага погашен (вход или блокировка)
    try {
      const sec = await repo.getSecurity(iin);
      if (sec.locked) {
        consumed = true;
        await repo.dropPending(pendingToken);
        return send(res, 423, { result: 'locked', locked: true });
      }
      if (typeof body.image !== 'string' || body.image.length === 0) {
        throw new HttpError(400, 'invalid_input');
      }
      // Нейросеть работает по очереди; длинную очередь не копим, чтобы сервер нельзя было завалить снимками.
      if (faceInFlight >= cfg.maxFaceQueue) throw new HttpError(503, 'busy', { retryAfterSec: 2 });

      let result;
      faceInFlight++;
      try {
        // Снимок живёт только в памяти на время проверки и нигде не сохраняется.
        result = await face.verify({
          iin,
          image: Buffer.from(body.image, 'base64'),
          templates: await repo.listTemplates(iin),
        });
      } catch {
        result = 'error';
      } finally {
        faceInFlight--;
      }

      // Пока шла проверка, аккаунт могли заблокировать.
      if ((await repo.getSecurity(iin)).locked) {
        consumed = true;
        await repo.dropPending(pendingToken);
        return send(res, 423, { result: 'locked', locked: true });
      }

      if (result === 'match') {
        await repo.resetOnLogin(iin);
        consumed = true;
        const sessionToken = await repo.completeLogin(pendingToken, iin, cfg.sessionTtlMs);
        const user = await repo.getUser(iin);
        audit('login_ok', iin);
        return send(res, 200, {
          result: 'match',
          sessionToken,
          user: { name: user.name, unit: user.unit },
          balance: user.balance,
          favorites: await repo.listFavorites(iin),
        });
      }

      if (result === 'noMatch') {
        // Верные ИИН и ПИН, но чужое лицо: возможна кража аккаунта.
        // Счётчик не обнуляется новым входом, ПИН нельзя пробовать с лицом бесконечно.
        const r = await repo.registerFaceFail(iin, { max: cfg.maxFaceAttempts });
        if (r.locked) {
          consumed = true;
          await repo.dropPending(pendingToken);
          audit('account_locked', iin, { reason: 'face' });
          return send(res, 423, { result: 'noMatch', locked: true });
        }
        audit('face_fail', iin, { fails: r.fails });
        return send(res, 200, { result: 'noMatch', attemptsLeft: cfg.maxFaceAttempts - r.fails });
      }

      // noFace / error не считаются попыткой (плохой свет, сбой камеры).
      const safe = result === 'noFace' ? 'noFace' : 'error';
      return send(res, 200, {
        result: safe,
        attemptsLeft: cfg.maxFaceAttempts - sec.faceFails,
      });
    } finally {
      if (!consumed) await repo.releasePending(pendingToken).catch(() => {});
    }
  }

  // ---------- каталог, избранное, заказы ----------

  async function setFavorite(session, productId, value) {
    try {
      return { favorites: await repo.setFavorite(session.iin, productId, value) };
    } catch (e) {
      if (e instanceof RepoError && e.code === 'unknown_product') throw new HttpError(404, 'unknown_product');
      throw e;
    }
  }

  async function placeOrder(session, body) {
    const { iin } = session;
    const requestId =
      typeof body.requestId === 'string' && body.requestId.length > 0 && body.requestId.length <= 64
        ? body.requestId
        : null;

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

    // Цены и остатки берутся только из базы, от клиента принимаем лишь «что и сколько».
    // Повтор того же запроса (например, после обрыва связи) не списывает деньги дважды.
    const r = await guard(() => repo.placeOrder(iin, requestId, merged));
    if (!r.replay) audit('order', iin, { total: r.order.total, items: r.order.items.length });
    return { order: publicOrder(r.order), balance: r.balance, replay: r.replay };
  }

  // ---------- маршрутизация ----------

  const enrollPage = fs.readFileSync(new URL('../public/enroll.html', import.meta.url));
  const panelPage = fs.readFileSync(new URL('../public/admin.html', import.meta.url));
  const catalogPage = fs.readFileSync(new URL('../public/catalog.html', import.meta.url));
  const ORDER_STATUSES = new Set(['ready', 'picked_up', 'cancelled', 'all']);

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;

    if (m === 'OPTIONS') {
      res.writeHead(204, res.cors);
      return res.end();
    }
    if (m === 'GET' && p === '/health') {
      // Для балансировщика: сервер жив и видит базу.
      try {
        await db.query('SELECT 1');
      } catch {
        return send(res, 503, { ok: false });
      }
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/enroll') {
      // Страница регистрации лица. Сама по себе безвредна: всё делают запросы /admin/* с ключом.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(enrollPage);
    }
    if (m === 'GET' && (p === '/panel' || p === '/panel/catalog')) {
      // Панели дежурного. Страницы сами по себе без секретов, все данные идут запросами /admin/* с ключом.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      return res.end(p === '/panel' ? panelPage : catalogPage);
    }

    if (m === 'POST' && p === '/api/login') return login(req, res);
    if (m === 'POST' && p === '/api/face') return faceStep(req, res);

    if (p.startsWith('/admin/')) {
      requireAdmin(req);
      if (m === 'GET' && p === '/admin/locked') {
        return send(res, 200, { locked: await repo.listLocked() });
      }
      if (m === 'POST' && p === '/admin/unlock') {
        const { iin } = await readJson(req, 4096);
        if (!isValidIin(iin)) throw new HttpError(400, 'invalid_input');
        const wasLocked = await repo.unlock(iin);
        audit('account_unlocked', iin);
        return send(res, 200, { ok: true, wasLocked });
      }
      if (m === 'POST' && p === '/admin/enroll') {
        // Регистрация эталона лица: сервер сохраняет только числовой шаблон, снимок выбрасывается.
        if (typeof face.extract !== 'function') throw new HttpError(501, 'face_demo_mode');
        const body = await readJson(req, 3 * 1024 * 1024);
        if (!isValidIin(body.iin) || !(await repo.getUser(body.iin))) throw new HttpError(404, 'unknown_user');
        if (typeof body.image !== 'string' || body.image.length === 0) {
          throw new HttpError(400, 'invalid_input');
        }
        const r = await face.extract(Buffer.from(body.image, 'base64'));
        if (r.status !== 'ok') throw new HttpError(422, 'face_' + r.status);
        const templates = await repo.addTemplate(body.iin, r.descriptor, {
          replace: body.replace === true,
          keep: cfg.maxFaceTemplates,
        });
        audit('face_enrolled', body.iin, { templates });
        return send(res, 200, { ok: true, templates });
      }
      if (m === 'GET' && p === '/admin/orders') {
        // status: ready (по умолчанию) | picked_up | cancelled | all; iin: история одного человека.
        const status = url.searchParams.get('status') ?? 'ready';
        if (!ORDER_STATUSES.has(status)) throw new HttpError(400, 'invalid_status');
        const iin = url.searchParams.get('iin');
        if (iin !== null && !isValidIin(iin)) throw new HttpError(400, 'invalid_input');
        if (iin) audit('admin_view_orders', iin); // кто смотрел чужую историю, остаётся в журнале
        const list = await repo.listOrders({ status, iin });
        return send(res, 200, { orders: list.map(adminOrder) });
      }
      if (m === 'GET' && p === '/admin/products') {
        return send(res, 200, { products: await repo.listAllProducts(), categories: CATEGORIES, icons: ICONS });
      }
      if (m === 'POST' && p === '/admin/products') {
        const input = parseProduct(await readJson(req, 8192), { create: true });
        const product = await guard(() => repo.createProduct({ ...input, active: input.active ?? true }));
        audit('product_created', null, { id: product.id });
        return send(res, 201, { product });
      }
      const prod = /^\/admin\/products\/([A-Za-z0-9_-]{1,32})(\/stock)?$/.exec(p);
      if (prod) {
        const id = prod[1];
        const notFound = { unknown_product: 404 };
        if (prod[2] && m === 'POST') {
          // Приход (+) или списание (−) остатка.
          const { delta } = await readJson(req, 4096);
          if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) {
            throw new HttpError(400, 'invalid_product', { field: 'delta' });
          }
          const product = await guard(() => repo.adjustStock(id, delta), notFound);
          audit('product_stock', null, { id, delta });
          return send(res, 200, { product });
        }
        if (!prod[2] && m === 'PUT') {
          const patch = parseProduct(await readJson(req, 8192), { create: false });
          const product = await guard(() => repo.updateProduct(id, patch), notFound);
          audit('product_updated', null, { id, fields: Object.keys(patch) });
          return send(res, 200, { product });
        }
        if (!prod[2] && m === 'DELETE') {
          await guard(() => repo.deleteProduct(id), notFound);
          audit('product_deleted', null, { id });
          return send(res, 200, { ok: true });
        }
      }
      if (m === 'GET' && p === '/admin/users') {
        // Поиск человека по части имени или ИИН (для просмотра истории и пополнения).
        const users = await repo.searchUsers((url.searchParams.get('q') ?? '').trim());
        return send(res, 200, { users });
      }
      if (m === 'POST' && p === '/admin/orders/pickup') {
        const o = await guard(async () => repo.pickupOrder(await readJson(req, 4096)));
        audit('order_picked_up', o.iin, { total: o.total });
        return send(res, 200, { order: adminOrder(o) });
      }
      if (m === 'POST' && p === '/admin/orders/cancel') {
        const r = await guard(async () => repo.cancelOrder(await readJson(req, 4096)));
        audit('order_cancelled', r.order.iin, { total: r.order.total });
        return send(res, 200, { order: adminOrder(r.order), balance: r.balance });
      }
      if (m === 'POST' && p === '/admin/balance') {
        // Пополнение (или списание при отрицательной сумме) баланса дежурным.
        const { iin, amount, note } = await readJson(req, 4096);
        if (!isValidIin(iin) || !(await repo.getUser(iin))) throw new HttpError(404, 'unknown_user');
        if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
          throw new HttpError(400, 'invalid_amount');
        }
        const balance = await guard(() =>
          repo.adjustBalance(iin, amount, typeof note === 'string' && note ? note.slice(0, 200) : null),
        );
        audit('balance_adjusted', iin, { amount });
        return send(res, 200, { balance });
      }
      if (m === 'GET' && p === '/admin/ledger') {
        const iin = url.searchParams.get('iin');
        const rows = await repo.listLedger(iin || null);
        return send(res, 200, { ledger: rows.map((r) => ({ ...r, iin: maskIin(r.iin) })) });
      }
      if (m === 'GET' && p === '/admin/enrolled') {
        const out = (await repo.listEnrolled()).map((u) => ({
          iin: maskIin(u.iin),
          name: u.name,
          templates: u.templates,
        }));
        return send(res, 200, { users: out });
      }
      if (m === 'POST' && p === '/admin/unenroll') {
        const { iin } = await readJson(req, 4096);
        if (!isValidIin(iin)) throw new HttpError(400, 'invalid_input');
        await repo.deleteTemplates(iin);
        audit('face_unenrolled', iin);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, 'not_found');
    }

    if (p.startsWith('/api/')) {
      const session = await requireSession(req);

      if (m === 'GET' && p === '/api/catalog') {
        return send(res, 200, { products: await repo.listProducts() });
      }
      if (m === 'GET' && p === '/api/me') {
        return send(res, 200, {
          user: { name: session.user.name, unit: session.user.unit },
          balance: session.user.balance,
          favorites: await repo.listFavorites(session.iin),
        });
      }
      const fav = /^\/api\/favorites\/([A-Za-z0-9_-]{1,32})$/.exec(p);
      if (fav && (m === 'PUT' || m === 'DELETE')) {
        return send(res, 200, await setFavorite(session, fav[1], m === 'PUT'));
      }
      if (m === 'GET' && p === '/api/orders') {
        // Только заказы владельца сеанса: ИИН берётся из токена, не из запроса.
        const mine = await repo.listUserOrders(session.iin, 50);
        return send(res, 200, { orders: mine.map(publicOrder) });
      }
      if (m === 'POST' && p === '/api/orders') {
        const body = await readJson(req, 16 * 1024);
        const result = await placeOrder(session, body);
        return send(res, result.replay ? 200 : 201, result);
      }
      if (m === 'POST' && p === '/api/logout') {
        await repo.deleteSession(session.token);
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
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    repo.gc().catch((e) => console.error('Очистка сеансов:', e?.message ?? e));
  }, 60_000);
  gc.unref();

  return {
    server,
    db,
    repo,
    async close() {
      clearInterval(gc);
      if (server.listening) {
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
      }
      if (ownsDb) await db.close();
    },
  };
}
