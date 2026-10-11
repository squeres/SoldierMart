import crypto from 'node:crypto';
import { encryptJson, decryptJson, isEncrypted } from './secret.js';

/**
 * Все обращения к данным. Каждая функция, меняющая деньги, остатки или счётчики,
 * делает это в одной транзакции с блокировкой строк (`FOR UPDATE`) — результат не
 * зависит ни от гонки запросов, ни от числа запущенных серверов.
 *
 * Ошибки бизнес-логики бросаются как `RepoError(code, extra)`; приложение превращает их в HTTP-ответы.
 */

export class RepoError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

const iso = (d) => (d ? new Date(d).toISOString() : undefined);
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function createRepo(db, { secretKey = null } = {}) {
  // ---------- пользователи ----------

  const mapUser = (r) =>
    r && {
      iin: r.iin,
      name: r.name,
      unit: r.unit,
      balance: r.balance,
      pinSalt: r.pin_salt,
      pinHash: r.pin_hash,
    };

  async function getUser(iin) {
    const { rows } = await db.query('SELECT * FROM users WHERE iin = $1', [iin]);
    return mapUser(rows[0]);
  }

  async function createUser(x, u) {
    await x.query(
      'INSERT INTO users (iin, name, unit, balance, pin_salt, pin_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [u.iin, u.name, u.unit, u.balance, u.pinSalt, u.pinHash],
    );
  }

  async function searchUsers(q) {
    const like = `%${q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
    const { rows } = await db.query(
      `SELECT iin, name, unit, balance FROM users
        WHERE $1 = '' OR lower(name) LIKE $2 OR iin LIKE $2
        ORDER BY name LIMIT 50`,
      [q, like],
    );
    return rows;
  }

  // ---------- каталог и избранное ----------

  const mapProduct = (r) => ({
    id: r.id,
    nameRu: r.name_ru,
    nameKk: r.name_kk,
    category: r.category,
    price: r.price,
    icon: r.icon,
    stock: r.stock,
  });

  async function listProducts() {
    const { rows } = await db.query('SELECT * FROM products ORDER BY pos');
    return rows.map(mapProduct);
  }

  async function insertProducts(x, products) {
    let pos = 0;
    for (const p of products) {
      await x.query(
        'INSERT INTO products (id, pos, name_ru, name_kk, category, price, icon, stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [p.id, pos++, p.nameRu, p.nameKk, p.category, p.price, p.icon, p.stock],
      );
    }
  }

  async function countProducts() {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM products');
    return rows[0].n;
  }

  async function listFavorites(iin) {
    const { rows } = await db.query(
      `SELECT f.product_id FROM favorites f JOIN products p ON p.id = f.product_id
        WHERE f.iin = $1 ORDER BY p.pos`,
      [iin],
    );
    return rows.map((r) => r.product_id);
  }

  async function setFavorite(iin, productId, value) {
    const { rows } = await db.query('SELECT 1 FROM products WHERE id = $1', [productId]);
    if (!rows.length) throw new RepoError('unknown_product');
    if (value) {
      await db.query(
        'INSERT INTO favorites (iin, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [iin, productId],
      );
    } else {
      await db.query('DELETE FROM favorites WHERE iin = $1 AND product_id = $2', [iin, productId]);
    }
    return listFavorites(iin);
  }

  // ---------- блокировки и счётчики ----------

  const mapSecurity = (r) => ({
    pinFails: r?.pin_fails ?? 0,
    faceFails: r?.face_fails ?? 0,
    strikes: r?.strikes ?? 0,
    locked: Boolean(r?.locked_at),
    reason: r?.locked_reason ?? null,
    until: iso(r?.locked_until) ?? null,
  });

  /** Снимает временную блокировку, срок которой вышел. */
  const clearExpiredLock = (x, iin) =>
    x.query(
      `UPDATE security SET locked_at = NULL, locked_reason = NULL, locked_until = NULL, pin_fails = 0
        WHERE iin = $1 AND locked_until IS NOT NULL AND locked_until <= now()`,
      [iin],
    );

  async function getSecurity(iin) {
    await clearExpiredLock(db, iin);
    const { rows } = await db.query('SELECT * FROM security WHERE iin = $1', [iin]);
    return mapSecurity(rows[0]);
  }

  /**
   * Неверный ПИН. Счётчик растёт одним атомарным запросом, поэтому параллельные
   * попытки (в том числе на разных серверах) не могут обойти лимит.
   * @returns {{locked: boolean, fails: number, until: string|null}}
   */
  async function registerPinFail(iin, { max, baseMs, maxMs }) {
    return db.tx(async (t) => {
      await clearExpiredLock(t, iin);
      const up = await t.query(
        `INSERT INTO security (iin, pin_fails) VALUES ($1, 1)
         ON CONFLICT (iin) DO UPDATE SET pin_fails = security.pin_fails + 1
           WHERE security.locked_at IS NULL
         RETURNING pin_fails, strikes`,
        [iin],
      );
      if (!up.rows.length) {
        // Пока шла проверка ПИН, аккаунт уже заблокировали: эта попытка не считается.
        const cur = await t.query('SELECT * FROM security WHERE iin = $1', [iin]);
        const s = mapSecurity(cur.rows[0]);
        return { locked: true, fails: 0, until: s.until, already: true };
      }
      const { pin_fails: fails, strikes } = up.rows[0];
      if (fails < max) return { locked: false, fails, until: null };

      // Блокировка временная: 15 мин, 30 мин, 1 ч ... до суток; каждая следующая подряд вдвое дольше.
      const next = strikes + 1;
      const ms = Math.min(baseMs * 2 ** (next - 1), maxMs);
      const lock = await t.query(
        `UPDATE security SET strikes = $2, pin_fails = 0, locked_at = now(), locked_reason = 'pin',
                locked_until = now() + ($3 || ' milliseconds')::interval
          WHERE iin = $1 RETURNING locked_until`,
        [iin, next, String(ms)],
      );
      return { locked: true, fails, until: iso(lock.rows[0].locked_until) };
    });
  }

  async function resetPinFails(iin) {
    await db.query('UPDATE security SET pin_fails = 0 WHERE iin = $1', [iin]);
  }

  /**
   * Неудачная проверка лица при верном ПИН. Блокировка по лицу жёсткая (без срока).
   * @returns {{locked: boolean, fails: number}}
   */
  async function registerFaceFail(iin, { max }) {
    return db.tx(async (t) => {
      const up = await t.query(
        `INSERT INTO security (iin, face_fails) VALUES ($1, 1)
         ON CONFLICT (iin) DO UPDATE SET face_fails = security.face_fails + 1
           WHERE security.locked_at IS NULL
         RETURNING face_fails`,
        [iin],
      );
      if (!up.rows.length) return { locked: true, fails: 0 };
      const fails = up.rows[0].face_fails;
      if (fails < max) return { locked: false, fails };
      await t.query(
        `UPDATE security SET locked_at = now(), locked_reason = 'face', locked_until = NULL WHERE iin = $1`,
        [iin],
      );
      return { locked: true, fails };
    });
  }

  /** Полный успешный вход: счётчики неудач и «штрафная история» блокировок обнуляются. */
  async function resetOnLogin(iin) {
    await db.query('UPDATE security SET face_fails = 0, strikes = 0, pin_fails = 0 WHERE iin = $1', [iin]);
  }

  async function unlock(iin) {
    const { rows } = await db.query('DELETE FROM security WHERE iin = $1 RETURNING locked_at', [iin]);
    return Boolean(rows[0]?.locked_at);
  }

  async function listLocked() {
    const { rows } = await db.query(
      `SELECT iin, locked_at, locked_reason, locked_until FROM security
        WHERE locked_at IS NOT NULL AND (locked_until IS NULL OR locked_until > now())
        ORDER BY locked_at DESC`,
    );
    return rows.map((r) => ({
      iin: r.iin,
      at: iso(r.locked_at),
      reason: r.locked_reason,
      ...(r.locked_until ? { until: iso(r.locked_until) } : {}),
    }));
  }

  // ---------- вход: шаг «лицо» и сеансы ----------

  async function createPending(iin, ttlMs) {
    const token = crypto.randomBytes(24).toString('hex');
    await db.query(
      `INSERT INTO pending_logins (token_hash, iin, expires_at)
       VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
      [hashToken(token), iin, String(ttlMs)],
    );
    return token;
  }

  /**
   * Занимает шаг «лицо» на время проверки: параллельный запрос с тем же токеном не пройдёт.
   * @returns {Promise<{iin: string}|{state: 'busy'|'missing'}>}
   */
  async function claimPending(token) {
    const h = hashToken(token);
    const { rows } = await db.query(
      `UPDATE pending_logins SET busy = true
        WHERE token_hash = $1 AND expires_at > now() AND busy = false RETURNING iin`,
      [h],
    );
    if (rows.length) return { iin: rows[0].iin };
    const cur = await db.query(
      'SELECT busy FROM pending_logins WHERE token_hash = $1 AND expires_at > now()',
      [h],
    );
    return { state: cur.rows.length ? 'busy' : 'missing' };
  }

  const releasePending = (token) =>
    db.query('UPDATE pending_logins SET busy = false WHERE token_hash = $1', [hashToken(token)]);

  const dropPending = (token) =>
    db.query('DELETE FROM pending_logins WHERE token_hash = $1', [hashToken(token)]);

  /** Шаг «лицо» пройден: токен шага гасится, выдаётся сеанс (в одной транзакции). */
  async function completeLogin(pendingToken, iin, ttlMs) {
    const token = crypto.randomBytes(24).toString('hex');
    await db.tx(async (t) => {
      await t.query('DELETE FROM pending_logins WHERE token_hash = $1', [hashToken(pendingToken)]);
      await t.query(
        `INSERT INTO sessions (token_hash, iin, expires_at)
         VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
        [hashToken(token), iin, String(ttlMs)],
      );
    });
    return token;
  }

  /** Находит сеанс и продлевает его. */
  async function touchSession(token, ttlMs) {
    const { rows } = await db.query(
      `WITH s AS (
         UPDATE sessions SET expires_at = now() + ($2 || ' milliseconds')::interval
          WHERE token_hash = $1 AND expires_at > now() RETURNING iin
       )
       SELECT u.* FROM s JOIN users u ON u.iin = s.iin`,
      [hashToken(token), String(ttlMs)],
    );
    return mapUser(rows[0]);
  }

  const deleteSession = (token) =>
    db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);

  async function gc() {
    await db.query('DELETE FROM sessions WHERE expires_at <= now()');
    await db.query('DELETE FROM pending_logins WHERE expires_at <= now()');
  }

  // ---------- эталоны лица ----------

  async function listTemplates(iin) {
    const { rows } = await db.query('SELECT descriptor FROM face_templates WHERE iin = $1 ORDER BY pos', [iin]);
    return rows.map((r) => decryptJson(secretKey, r.descriptor));
  }

  /** Добавляет шаблон, храня не больше `keep` последних; `replace` сначала стирает старые. */
  async function addTemplate(iin, descriptor, { replace, keep }) {
    await db.tx(async (t) => {
      await t.query('SELECT 1 FROM users WHERE iin = $1 FOR UPDATE', [iin]);
      if (replace) await t.query('DELETE FROM face_templates WHERE iin = $1', [iin]);
      const { rows } = await t.query('SELECT coalesce(max(pos), -1) + 1 AS next FROM face_templates WHERE iin = $1', [iin]);
      await t.query('INSERT INTO face_templates (iin, pos, descriptor) VALUES ($1,$2,$3)', [
        iin,
        rows[0].next,
        encryptJson(secretKey, descriptor),
      ]);
      await t.query(
        `DELETE FROM face_templates WHERE iin = $1 AND pos <= (
           SELECT pos FROM face_templates WHERE iin = $1 ORDER BY pos DESC OFFSET $2 LIMIT 1)`,
        [iin, keep],
      );
    });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM face_templates WHERE iin = $1', [iin]);
    return rows[0].n;
  }

  const deleteTemplates = (iin) => db.query('DELETE FROM face_templates WHERE iin = $1', [iin]);

  async function listEnrolled() {
    const { rows } = await db.query(
      `SELECT u.iin, u.name, count(f.pos)::int AS templates
         FROM users u LEFT JOIN face_templates f ON f.iin = u.iin
        GROUP BY u.iin, u.name ORDER BY u.name`,
    );
    return rows;
  }

  /**
   * Согласует хранение шаблонов с ключом: если ключ задан, открытые шаблоны шифруются;
   * если ключа нет, а зашифрованные есть, сервер не стартует (иначе биометрия «пропала» бы молча).
   */
  async function reconcileEncryption() {
    const { rows } = await db.query('SELECT iin, pos, descriptor FROM face_templates');
    const encrypted = rows.filter((r) => isEncrypted(r.descriptor));
    if (encrypted.length && !secretKey) {
      throw new Error('в базе есть зашифрованные шаблоны лиц, а ключ шифрования не задан (DATA_KEY)');
    }
    for (const r of encrypted) decryptJson(secretKey, r.descriptor); // неверный ключ -> ошибка GCM
    if (!secretKey) return;
    for (const r of rows.filter((x) => !isEncrypted(x.descriptor))) {
      await db.query('UPDATE face_templates SET descriptor = $3 WHERE iin = $1 AND pos = $2', [
        r.iin,
        r.pos,
        encryptJson(secretKey, JSON.parse(r.descriptor)),
      ]);
    }
  }

  // ---------- заказы ----------

  const mapOrder = (r, items) => ({
    id: r.id,
    iin: r.iin,
    code: r.code,
    total: r.total,
    status: r.status,
    createdAt: iso(r.created_at),
    ...(r.user_name ? { userName: r.user_name } : {}),
    ...(r.picked_up_at ? { pickedUpAt: iso(r.picked_up_at) } : {}),
    ...(r.cancelled_at ? { cancelledAt: iso(r.cancelled_at) } : {}),
    items: items.get(r.id) ?? [],
  });

  async function attachItems(x, rows) {
    const items = new Map();
    if (rows.length) {
      const { rows: its } = await x.query(
        'SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, pos',
        [rows.map((r) => r.id)],
      );
      for (const i of its) {
        if (!items.has(i.order_id)) items.set(i.order_id, []);
        items.get(i.order_id).push({
          productId: i.product_id,
          nameRu: i.name_ru,
          nameKk: i.name_kk,
          price: i.price,
          qty: i.qty,
        });
      }
    }
    return rows.map((r) => mapOrder(r, items));
  }

  /** Заказы человека, новые сверху. */
  async function listUserOrders(iin, limit = 50) {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE iin = $1 ORDER BY seq DESC LIMIT $2',
      [iin, limit],
    );
    return attachItems(db, rows);
  }

  /** Заказы для дежурного: по статусу ('all' = любые) и, по желанию, одного человека. */
  async function listOrders({ status, iin, limit = 200 }) {
    const { rows } = await db.query(
      `SELECT o.*, u.name AS user_name FROM orders o JOIN users u ON u.iin = o.iin
        WHERE ($1 = 'all' OR o.status = $1) AND ($2::text IS NULL OR o.iin = $2)
        ORDER BY o.seq DESC LIMIT $3`,
      [status, iin ?? null, limit],
    );
    return attachItems(db, rows);
  }

  async function getOrderByRequest(x, iin, requestId) {
    const { rows } = await x.query('SELECT * FROM orders WHERE iin = $1 AND request_id = $2', [iin, requestId]);
    return rows.length ? (await attachItems(x, rows))[0] : null;
  }

  const newCode = () => String(crypto.randomInt(100000, 1000000));

  /**
   * Оформление заказа целиком в одной транзакции: строки пользователя и товаров блокируются,
   * цены и остатки берутся из базы, деньги и остатки списываются, заказ и журнал пишутся.
   * Повторный запрос с тем же requestId возвращает уже созданный заказ.
   * @param {Map<string, number>} merged productId -> qty
   */
  async function placeOrder(iin, requestId, merged) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await db.tx(async (t) => {
          // Блокируем пользователя первым: два одновременных заказа одного человека идут по очереди.
          const u = await t.query('SELECT balance FROM users WHERE iin = $1 FOR UPDATE', [iin]);
          if (!u.rows.length) throw new RepoError('unknown_user');

          if (requestId) {
            const prev = await getOrderByRequest(t, iin, requestId);
            if (prev) return { order: prev, balance: u.rows[0].balance, replay: true };
          }

          // Товары блокируем в одном порядке (по id): так два заказа не встанут в тупик.
          const ids = [...merged.keys()].sort();
          const pr = await t.query('SELECT * FROM products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [ids]);
          const byId = new Map(pr.rows.map((p) => [p.id, p]));

          let total = 0;
          const lines = [];
          for (const [productId, qty] of merged) {
            const p = byId.get(productId);
            if (!p) throw new RepoError('unknown_product', { productId });
            if (p.stock < qty) throw new RepoError('out_of_stock', { productId, available: p.stock });
            total += p.price * qty;
            lines.push({ p, qty });
          }
          const balance = u.rows[0].balance;
          if (total > balance) throw new RepoError('insufficient_funds', { balance, total });

          for (const { p, qty } of lines) {
            await t.query('UPDATE products SET stock = stock - $2 WHERE id = $1', [p.id, qty]);
          }
          const upd = await t.query('UPDATE users SET balance = balance - $2 WHERE iin = $1 RETURNING balance', [iin, total]);
          const orderId = crypto.randomUUID();
          const ins = await t.query(
            `INSERT INTO orders (id, iin, request_id, code, status, total)
             VALUES ($1,$2,$3,$4,'ready',$5) RETURNING *`,
            [orderId, iin, requestId, newCode(), total],
          );
          let pos = 0;
          for (const { p, qty } of lines) {
            await t.query(
              'INSERT INTO order_items (order_id, pos, product_id, name_ru, name_kk, price, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [orderId, pos++, p.id, p.name_ru, p.name_kk, p.price, qty],
            );
          }
          await t.query(
            'INSERT INTO ledger (iin, type, amount, balance, order_id) VALUES ($1,$2,$3,$4,$5)',
            [iin, 'order', -total, upd.rows[0].balance, orderId],
          );
          const [order] = await attachItems(t, ins.rows);
          return { order, balance: upd.rows[0].balance, replay: false };
        });
      } catch (e) {
        // Занят случайный код выдачи среди ожидающих заказов: пробуем другой.
        if (e?.code === '23505' && String(e.constraint ?? e.message).includes('orders_ready_code_uq')) continue;
        throw e;
      }
    }
    throw new RepoError('try_again');
  }

  /** Заказ по id или по коду выдачи (код ищем среди ожидающих выдачи). */
  async function findOrderRow(t, { id, code }) {
    const uuid = /^[0-9a-f-]{36}$/i;
    if (typeof id === 'string' && uuid.test(id)) {
      const { rows } = await t.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (rows.length) return rows[0];
    }
    if (typeof code === 'string' && /^\d{6}$/.test(code)) {
      const { rows } = await t.query("SELECT * FROM orders WHERE code = $1 AND status = 'ready' FOR UPDATE", [code]);
      if (rows.length) return rows[0];
    }
    throw new RepoError('unknown_order');
  }

  async function pickupOrder(ref) {
    return db.tx(async (t) => {
      const o = await findOrderRow(t, ref);
      if (o.status !== 'ready') throw new RepoError('order_not_ready', { status: o.status });
      const { rows } = await t.query(
        "UPDATE orders SET status = 'picked_up', picked_up_at = now() WHERE id = $1 RETURNING *",
        [o.id],
      );
      return (await attachItems(t, rows))[0];
    });
  }

  /** Отмена до выдачи: деньги и остатки товаров возвращаются. */
  async function cancelOrder(ref) {
    return db.tx(async (t) => {
      const o = await findOrderRow(t, ref);
      if (o.status !== 'ready') throw new RepoError('order_not_ready', { status: o.status });
      // Порядок блокировок тот же, что при оформлении: пользователь, затем товары по id.
      await t.query('SELECT 1 FROM users WHERE iin = $1 FOR UPDATE', [o.iin]);
      const { rows: items } = await t.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.id]);
      await t.query('SELECT 1 FROM products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [items.map((i) => i.product_id)]);
      for (const i of items) {
        await t.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [i.product_id, i.qty]);
      }
      const upd = await t.query('UPDATE users SET balance = balance + $2 WHERE iin = $1 RETURNING balance', [o.iin, o.total]);
      await t.query(
        'INSERT INTO ledger (iin, type, amount, balance, order_id) VALUES ($1,$2,$3,$4,$5)',
        [o.iin, 'refund', o.total, upd.rows[0].balance, o.id],
      );
      const { rows } = await t.query(
        "UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1 RETURNING *",
        [o.id],
      );
      return { order: (await attachItems(t, rows))[0], balance: upd.rows[0].balance };
    });
  }

  // ---------- деньги ----------

  async function adjustBalance(iin, amount, note) {
    return db.tx(async (t) => {
      const u = await t.query('SELECT balance FROM users WHERE iin = $1 FOR UPDATE', [iin]);
      if (!u.rows.length) throw new RepoError('unknown_user');
      if (u.rows[0].balance + amount < 0) throw new RepoError('insufficient_funds', { balance: u.rows[0].balance });
      const upd = await t.query('UPDATE users SET balance = balance + $2 WHERE iin = $1 RETURNING balance', [iin, amount]);
      await t.query(
        'INSERT INTO ledger (iin, type, amount, balance, note) VALUES ($1,$2,$3,$4,$5)',
        [iin, amount > 0 ? 'topup' : 'debit', amount, upd.rows[0].balance, note ?? null],
      );
      return upd.rows[0].balance;
    });
  }

  async function listLedger(iin, limit = 200) {
    const { rows } = await db.query(
      'SELECT * FROM ledger WHERE ($1::text IS NULL OR iin = $1) ORDER BY id DESC LIMIT $2',
      [iin ?? null, limit],
    );
    return rows.map((r) => ({
      t: iso(r.t),
      iin: r.iin,
      type: r.type,
      amount: r.amount,
      balance: r.balance,
      ...(r.order_id ? { orderId: r.order_id } : {}),
      ...(r.note ? { note: r.note } : {}),
    }));
  }

  return {
    getUser, createUser, searchUsers,
    listProducts, insertProducts, countProducts, listFavorites, setFavorite,
    getSecurity, registerPinFail, resetPinFails, registerFaceFail, resetOnLogin, unlock, listLocked,
    createPending, claimPending, releasePending, dropPending, completeLogin, touchSession, deleteSession, gc,
    listTemplates, addTemplate, deleteTemplates, listEnrolled, reconcileEncryption,
    listUserOrders, listOrders, placeOrder, pickupOrder, cancelOrder,
    adjustBalance, listLedger,
  };
}
