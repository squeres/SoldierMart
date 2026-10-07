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

const app = await createApp({
  dbPath: path.join(dataDir, 'db.json'),
  auditPath: path.join(dataDir, 'audit.log'),
  adminKey,
  secretKey: dataKey,
  face,
  tls,
  corsOrigins,
  trustProxy: process.env.TRUST_PROXY === '1',
  ...(process.env.RATE_LIMIT_PER_MIN ? { rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN) } : {}),
});

app.server.listen(PORT, HOST, () => {
  console.log('SoldierMart сервер запущен');
  console.log(`  Адрес:        ${tls ? 'https' : 'http'}://${HOST}:${PORT}`);
  console.log(`  Данные:       ${dataDir}`);
  // Сам ключ в консоль не печатаем: она попадает в журналы и на экраны.
  console.log(
    process.env.ADMIN_KEY
      ? '  Ключ дежурного: задан переменной ADMIN_KEY'
      : `  Ключ дежурного: в файле ${keyFile}`,
  );
  console.log('  Шаблоны лиц в базе: зашифрованы (AES-256-GCM)');
  if (!tls) console.log('  ВНИМАНИЕ: HTTPS выключен (TLS_CERT/TLS_KEY). Для боя обязателен.');
  if (!corsOrigins) console.log('  ВНИМАНИЕ: CORS открыт для всех (CORS_ORIGINS не задан). Для боя ограничьте.');
  console.log('  ВНИМАНИЕ: защиты от подделки лица (фото, экран) нет, см. README.');
  if (!face.isDemo) {
    const n = Object.keys(app.store.data.faceTemplates).length;
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

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close(); // дописывает базу на диск
    process.exit(0);
  });
}
