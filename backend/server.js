import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { DemoFaceVerifier } from './src/face.js';
import { RealFaceVerifier } from './src/face-real.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.join(here, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.PORT ?? 8080);
// По умолчанию слушаем только этот компьютер. Для терминалов в локальной сети:
// HOST=0.0.0.0 (и откройте порт в брандмауэре).
const HOST = process.env.HOST ?? '127.0.0.1';

// Ключ администратора (дежурного): из переменной ADMIN_KEY или из файла,
// который создаётся при первом запуске.
const keyFile = path.join(dataDir, 'admin.key');
let adminKey = process.env.ADMIN_KEY;
if (!adminKey) {
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(16).toString('hex'), { mode: 0o600 });
  }
  adminKey = fs.readFileSync(keyFile, 'utf8').trim();
}

// Ключ шифрования шаблонов лиц в базе: из DATA_KEY или из файла (создаётся при первом запуске).
// В бою держите ключ отдельно от базы (переменная окружения, хранилище секретов), иначе
// шифрование защитит только от копирования одного файла db.json.
const dataKeyFile = path.join(dataDir, 'data.key');
let dataKey = process.env.DATA_KEY;
if (!dataKey) {
  if (!fs.existsSync(dataKeyFile)) {
    fs.writeFileSync(dataKeyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  dataKey = fs.readFileSync(dataKeyFile, 'utf8').trim();
}

// HTTPS: TLS_CERT и TLS_KEY — пути к файлам сертификата и ключа.
let tls = null;
if (process.env.TLS_CERT || process.env.TLS_KEY) {
  if (!(process.env.TLS_CERT && process.env.TLS_KEY)) {
    console.error('Для HTTPS нужны обе переменные: TLS_CERT и TLS_KEY.');
    process.exit(1);
  }
  tls = {
    cert: fs.readFileSync(process.env.TLS_CERT),
    key: fs.readFileSync(process.env.TLS_KEY),
  };
}

// CORS: список адресов через запятую. Без него разрешены любые (только для разработки).
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean)
  : null;

// По умолчанию распознавание настоящее. FACE_MODE=demo включает заглушку без защиты.
let face;
if (process.env.FACE_MODE === 'demo') {
  face = new DemoFaceVerifier({ forced: process.env.FACE_DEMO_RESULT });
} else {
  try {
    face = await new RealFaceVerifier({
      threshold: process.env.FACE_THRESHOLD ? Number(process.env.FACE_THRESHOLD) : undefined,
    }).init();
  } catch (e) {
    console.error('Не удалось запустить распознавание лица:', e?.message ?? e);
    console.error('Выполните в папке backend команду: npm install');
    console.error('(или запустите без распознавания: FACE_MODE=demo, защиты это не даёт)');
    process.exit(1);
  }
}

// База: PostgreSQL по DATABASE_URL (бой) или встроенная в папке данных (разработка, один сервер).
const databaseUrl = process.env.DATABASE_URL || undefined;
// Демо-пользователи с известными ПИН нужны только для разработки: с настоящей базой их не создаём.
const seedDemoUsers = process.env.SEED_DEMO_USERS === '1' || (!databaseUrl && process.env.SEED_DEMO_USERS !== '0');

let app;
try {
  app = await createApp({
  databaseUrl,
  dataDir,
  seedDemoUsers,
  auditPath: path.join(dataDir, 'audit.log'),
  adminKey,
  secretKey: dataKey,
  face,
  tls,
  corsOrigins,
  trustProxy: process.env.TRUST_PROXY === '1',
  ...(process.env.RATE_LIMIT_PER_MIN ? { rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN) } : {}),
  });
} catch (e) {
  console.error('Сервер не запущен:', e?.message ?? e);
  process.exit(1);
}

// Только для разработки без камеры: `npm run dev` создаёт тестовый аккаунт с «зарегистрированным» лицом.
// Работает лишь при FACE_MODE=demo, где лицо и так не проверяется. В бою не включается.
if (process.env.DEV_TEST_USER === '1') {
  if (!face.isDemo) {
    console.error('DEV_TEST_USER=1 работает только вместе с FACE_MODE=demo.');
    process.exit(1);
  }
  const { hashPin } = await import('./src/pin.js');
  const iin = '900101300007'; // вымышленный, проходит проверку контрольной цифры
  if (!(await app.repo.getUser(iin))) {
    await app.repo.createUser(app.db, {
      iin,
      name: 'Тестовый Солдат',
      unit: 'в/ч 00000, тест',
      balance: 50000,
      ...(await hashPin('1111')),
    });
  }
  if (!(await app.repo.listTemplates(iin)).length) {
    await app.repo.addTemplate(iin, new Array(128).fill(0), { replace: true, keep: 3 });
  }
  await app.repo.unlock(iin);
}

// Старые данные из db.json (версия до PostgreSQL) сами не переносятся.
const legacyJson = path.join(dataDir, 'db.json');
const legacyNote =
  fs.existsSync(legacyJson) && !fs.existsSync(legacyJson + '.imported')
    ? 'Найден старый файл db.json: перенесите данные командой `npm run migrate-json`.'
    : null;

app.server.listen(PORT, HOST, async () => {
  console.log('SoldierMart сервер запущен');
  if (process.env.DEV_TEST_USER === '1') {
    console.log('  ТЕСТОВЫЙ АККАУНТ (только для разработки): ИИН 900101300007, ПИН 1111, лицо «зарегистрировано».');
  }
  console.log(`  Адрес:        ${tls ? 'https' : 'http'}://${HOST}:${PORT}`);
  console.log(`  База данных:  ${databaseUrl ? 'PostgreSQL (DATABASE_URL)' : `встроенная, ${path.join(dataDir, 'pgdata')} (для одного сервера; в бою задайте DATABASE_URL)`}`);
  if (legacyNote) console.log(`  ${legacyNote}`);
  // Сам ключ в консоль не печатаем: она попадает в журналы и на экраны.
  console.log(
    process.env.ADMIN_KEY
      ? '  Ключ дежурного: задан переменной ADMIN_KEY'
      : `  Ключ дежурного: в файле ${keyFile}`,
  );
  console.log('  Шаблоны лиц в базе: зашифрованы (AES-256-GCM)');
  if (!tls) console.log('  ВНИМАНИЕ: HTTPS выключен (TLS_CERT/TLS_KEY). Для боя обязателен.');
  if (!corsOrigins) console.log('  ВНИМАНИЕ: CORS открыт для всех (CORS_ORIGINS не задан). Для боя ограничьте.');
  console.log(`  Панель дежурного: ${tls ? 'https' : 'http'}://${HOST}:${PORT}/panel`);
  console.log('  ВНИМАНИЕ: защиты от подделки лица (фото, экран) нет, см. README.');
  if (!face.isDemo) {
    const n = (await app.repo.listEnrolled()).filter((u) => u.templates > 0).length;
    console.log(`  Распознавание лица: включено (порог ${face.threshold}). Эталонов: ${n}.`);
    console.log(`  Регистрация лиц: http://${HOST}:${PORT}/enroll`);
    if (n === 0) {
      console.log('  Пока ни у кого нет эталона лица, войти не получится: сначала зарегистрируйте лицо.');
    }
  } else {
    console.log(
      '  ВНИМАНИЕ: проверка лица в режиме ДЕМО, любое лицо проходит' +
        (face.forced ? ` (принудительно: ${face.forced})` : '') +
        '. Защиты не даёт.',
    );
  }
});

// SIGBREAK и SIGHUP приходят в Windows при закрытии окна консоли: тоже закрываем базу аккуратно.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
