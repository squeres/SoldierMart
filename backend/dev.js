// Запуск для разработки без камеры и без нейросети: node dev.js (или npm run dev).
// Лицо не проверяется (демо), создаётся тестовый аккаунт. Для боя не использовать.
process.env.FACE_MODE = 'demo';
process.env.DEV_TEST_USER = '1';
await import('./server.js');
