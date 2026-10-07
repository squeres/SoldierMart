import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 32;

/**
 * Хэш ПИН-кода (scrypt с солью). ВАЖНО: 4-значный ПИН нельзя защитить
 * хэшированием, перебрать 10 000 вариантов можно мгновенно, если украсть
 * файл базы. Реальная защита ПИН здесь только блокировка аккаунта и
 * защита самой базы данных.
 */
export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pin, salt, KEY_LEN);
  return { pinSalt: salt.toString('hex'), pinHash: hash.toString('hex') };
}

const DUMMY = { pinSalt: '00'.repeat(16), pinHash: '00'.repeat(KEY_LEN) };

/**
 * Проверка ПИН. Для несуществующего пользователя всё равно выполняется
 * то же вычисление, чтобы по времени ответа нельзя было отличить
 * «нет такого ИИН» от «неверный ПИН».
 */
export async function verifyPin(pin, user) {
  const rec = user ?? DUMMY;
  const calc = await scrypt(pin, Buffer.from(rec.pinSalt, 'hex'), KEY_LEN);
  const same = crypto.timingSafeEqual(calc, Buffer.from(rec.pinHash, 'hex'));
  return Boolean(user) && same;
}
