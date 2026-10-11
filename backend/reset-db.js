// Сброс встроенной базы (только для разработки): папка pgdata переименовывается, а не удаляется.
// При следующем запуске сервера создаётся чистая база (каталог и демо-пользователи).
// Сервер должен быть остановлен. С настоящим PostgreSQL (DATABASE_URL) эта команда не нужна.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.join(here, 'data');
const dir = path.join(dataDir, 'pgdata');

if (process.env.DATABASE_URL) {
  console.error('Задан DATABASE_URL: сбрасывать нечего, встроенная база не используется.');
  process.exit(2);
}
if (!fs.existsSync(dir)) {
  console.log(`Папки ${dir} нет, сбрасывать нечего.`);
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = `${dir}.broken-${stamp}`;
try {
  fs.renameSync(dir, target);
} catch (e) {
  console.error(`Не удалось переименовать (возможно, сервер ещё запущен): ${e.message}`);
  process.exit(1);
}
console.log(`Готово. Старая база сохранена здесь: ${target}`);
console.log('Её можно удалить вручную, когда убедитесь, что данные не нужны. Запустите сервер: npm run dev');
