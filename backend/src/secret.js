import crypto from 'node:crypto';

/**
 * Шифрование биометрических шаблонов в базе (AES-256-GCM).
 * Формат значения: `v1:<iv>:<tag>:<данные>` (base64). Без ключа шаблон хранится обычным JSON.
 * GCM проверяет целостность: неверный ключ или подмена данных не расшифруются.
 */

export const toKey = (secret) =>
  secret ? crypto.createHash('sha256').update(String(secret)).digest() : null;

export const isEncrypted = (text) => typeof text === 'string' && text.startsWith('v1:');

export function encryptJson(key, value) {
  const json = JSON.stringify(value);
  if (!key) return json;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}

export function decryptJson(key, text) {
  if (!isEncrypted(text)) return JSON.parse(text);
  if (!key) throw new Error('шаблон зашифрован, а ключ шифрования не задан (DATA_KEY)');
  const [, iv, tag, body] = text.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]);
  return JSON.parse(out.toString('utf8'));
}
