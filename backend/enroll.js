// Регистрация эталона лица из файлов (альтернатива странице /enroll).
// Использование: node enroll.js <ИИН> <фото1.jpg> [фото2.jpg ...]
// Сервер должен быть запущен. Ключ берётся из data/admin.key или переменной ADMIN_KEY.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [iin, ...files] = process.argv.slice(2);
if (!iin || files.length === 0) {
  console.error('Использование: node enroll.js <ИИН> <фото1.jpg> [фото2.jpg ...]');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.join(here, 'data');
const key = process.env.ADMIN_KEY ?? fs.readFileSync(path.join(dataDir, 'admin.key'), 'utf8').trim();
const base = process.env.API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;

let first = true;
for (const f of files) {
  const image = fs.readFileSync(f).toString('base64');
  const r = await fetch(`${base}/admin/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
    body: JSON.stringify({ iin, image, replace: first }),
  });
  const j = await r.json().catch(() => ({}));
  console.log(r.ok ? `${f}: сохранено (шаблонов: ${j.templates})` : `${f}: отказ (${j.error ?? r.status})`);
  first = false;
}
