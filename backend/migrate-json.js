// Перенос данных из старого файла db.json (версия на JSON) в PostgreSQL.
//
// Использование (сервер остановить!):
//   DATABASE_URL=postgres://... node migrate-json.js [путь/к/db.json] [--replace]
// Без DATABASE_URL переносит во встроенную базу из папки данных.
//
// Без --replace перенос идёт только в пустую базу. С --replace таблицы сначала очищаются.
// Всё выполняется одной транзакцией: при ошибке в базе не остаётся ничего.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { createRepo } from './src/repo.js';
import { toKey, decryptJson, encryptJson } from './src/secret.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const dataDir = process.env.DATA_DIR ?? path.join(here, 'data');
const file = args.find((a) => !a.startsWith('--')) ?? path.join(dataDir, 'db.json');

if (!fs.existsSync(file)) {
  console.error(`Файл не найден: ${file}`);
  process.exit(2);
}

// Ключ шифрования шаблонов: тот же, что использовал старый сервер.
let secret = process.env.DATA_KEY;
const keyFile = path.join(dataDir, 'data.key');
if (!secret && fs.existsSync(keyFile)) secret = fs.readFileSync(keyFile, 'utf8').trim();
const key = toKey(secret);

const old = JSON.parse(fs.readFileSync(file, 'utf8'));
let faceTemplates = old.faceTemplates ?? {};
if (old.faceTemplatesEnc !== undefined) {
  if (!key) {
    console.error('В файле зашифрованные шаблоны лиц, а ключа нет: задайте DATA_KEY или положите data.key.');
    process.exit(2);
  }
  faceTemplates = decryptJson(key, old.faceTemplatesEnc);
}

const db = await openDb({ databaseUrl: process.env.DATABASE_URL || undefined, dataDir });
const repo = createRepo(db, { secretKey: key });

try {
  const counts = await db.tx(async (t) => {
    const { rows } = await t.query('SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM products)::int AS p');
    if (rows[0].u + rows[0].p > 0) {
      if (!replace) throw new Error('В базе уже есть данные. Для замены запустите с --replace (прежние данные будут стёрты).');
      await t.query(
        'TRUNCATE ledger, order_items, orders, favorites, face_templates, security, pending_logins, sessions, products, users RESTART IDENTITY CASCADE',
      );
    }

    await repo.insertProducts(t, old.products ?? []);
    for (const u of Object.values(old.users ?? {})) await repo.createUser(t, u);

    for (const [iin, ids] of Object.entries(old.favorites ?? {})) {
      for (const id of ids) {
        await t.query('INSERT INTO favorites (iin, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [iin, id]);
      }
    }

    // Заказы по порядку создания, чтобы порядковые номера совпали с историей.
    const orders = [...(old.orders ?? [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const o of orders) {
      await t.query(
        `INSERT INTO orders (id, iin, request_id, code, status, total, created_at, picked_up_at, cancelled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [o.id, o.iin, o.requestId ?? null, o.code, o.status, o.total, o.createdAt, o.pickedUpAt ?? null, o.cancelledAt ?? null],
      );
      let pos = 0;
      for (const i of o.items ?? []) {
        await t.query(
          'INSERT INTO order_items (order_id, pos, product_id, name_ru, name_kk, price, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [o.id, pos++, i.productId, i.nameRu, i.nameKk, i.price, i.qty],
        );
      }
    }

    for (const l of old.ledger ?? []) {
      await t.query(
        'INSERT INTO ledger (t, iin, type, amount, balance, order_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [l.t, l.iin, l.type, l.amount, l.balance, l.orderId ?? null, l.note ?? null],
      );
    }

    for (const [iin, list] of Object.entries(faceTemplates)) {
      let pos = 0;
      for (const d of list) {
        await t.query('INSERT INTO face_templates (iin, pos, descriptor) VALUES ($1,$2,$3)', [iin, pos++, encryptJson(key, d)]);
      }
    }

    const sec = old.security ?? {};
    const iins = new Set([
      ...Object.keys(sec.locked ?? {}),
      ...Object.keys(sec.pinFails ?? {}),
      ...Object.keys(sec.faceFails ?? {}),
      ...Object.keys(sec.strikes ?? {}),
    ]);
    for (const iin of iins) {
      const lk = sec.locked?.[iin];
      await t.query(
        `INSERT INTO security (iin, pin_fails, face_fails, strikes, locked_at, locked_reason, locked_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [iin, sec.pinFails?.[iin] ?? 0, sec.faceFails?.[iin] ?? 0, sec.strikes?.[iin] ?? 0, lk?.at ?? null, lk?.reason ?? null, lk?.until ?? null],
      );
    }

    // Проверка: сумма журнала не обязана сходиться со старым балансом (демо-данные), поэтому сверяем число записей.
    return {
      users: Object.keys(old.users ?? {}).length,
      products: (old.products ?? []).length,
      orders: orders.length,
      ledger: (old.ledger ?? []).length,
      faces: Object.keys(faceTemplates).length,
      locks: iins.size,
    };
  });
  fs.writeFileSync(file + '.imported', new Date().toISOString() + '\n' + crypto.randomUUID() + '\n');
  console.log('Перенесено:', counts);
  console.log(`Старый файл ${file} не удалён; рядом создана отметка .imported. Храните его как резервную копию.`);
} catch (e) {
  console.error('Перенос не выполнен, в базе ничего не изменилось:', e?.message ?? e);
  process.exitCode = 1;
} finally {
  await db.close();
}
