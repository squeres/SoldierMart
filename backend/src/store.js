import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { seedData } from './seed.js';

/**
 * Хранилище в одном JSON-файле. Для демо и локальной разработки.
 * Для боевого запуска заменить на настоящую БД (PostgreSQL) с транзакциями.
 *
 * Что здесь уже сделано, чтобы не терять и не портить данные:
 *  - запись через временный файл и переименование (сбой посреди записи не портит базу);
 *  - записи группируются и идут асинхронно, цикл событий сервера не блокируется;
 *    `await store.save()` возвращается, когда данные уже на диске;
 *  - перед первой записью за сутки делается копия `db.json.bak-ГГГГ-ММ-ДД` (хранится 7 последних);
 *  - если задан `secretKey`, шаблоны лиц (биометрия) лежат в файле зашифрованными (AES-256-GCM).
 */

const BACKUPS_KEEP = 7;
const FACE_FIELD = 'faceTemplates';
const FACE_ENC_FIELD = 'faceTemplatesEnc';

function toKey(secret) {
  if (!secret) return null;
  // Ключ любой длины приводим к 32 байтам; принимаем и hex-строку, и произвольную фразу.
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(key, value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}

function decrypt(key, text) {
  const [ver, iv, tag, body] = String(text).split(':');
  if (ver !== 'v1') throw new Error('неизвестный формат шифрования');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]);
  return JSON.parse(out.toString('utf8'));
}

export class Store {
  constructor(file, data, key = null) {
    this.file = file;
    this.data = data;
    this.key = key;
    this._dirty = false;
    this._writing = null; // идущая сейчас запись
    this._waiters = []; // кто ждёт ближайшей записи
    this._backupDay = null;
  }

  /**
   * @param {string} file
   * @param {{secretKey?: string}} [opts]
   */
  static async open(file, { secretKey } = {}) {
    const key = toKey(secretKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data[FACE_ENC_FIELD] !== undefined) {
        if (!key) throw new Error('база содержит зашифрованные шаблоны лиц, а ключ шифрования не задан (DATA_KEY)');
        // Неверный ключ или повреждённый файл: GCM не даст расшифровать, сервер не стартует.
        data[FACE_FIELD] = decrypt(key, data[FACE_ENC_FIELD]);
        delete data[FACE_ENC_FIELD];
      }
      data.users ??= {};
      data.products ??= [];
      data.favorites ??= {};
      data.orders ??= [];
      data.ledger ??= [];
      data[FACE_FIELD] ??= {};
      data.security ??= {};
      data.security.locked ??= {};
      data.security.pinFails ??= {};
      data.security.faceFails ??= {};
      data.security.strikes ??= {};
      const store = new Store(file, data, key);
      // Если ключ только что включили, а база была в открытом виде, перезапишем её зашифрованной.
      if (key) await store.save();
      return store;
    }
    const store = new Store(file, await seedData(), key);
    await store.save();
    return store;
  }

  /** Сериализация в вид, пригодный для файла. */
  _serialize() {
    if (!this.key) return JSON.stringify(this.data, null, 2);
    const { [FACE_FIELD]: faces, ...rest } = this.data;
    return JSON.stringify({ ...rest, [FACE_ENC_FIELD]: encrypt(this.key, faces ?? {}) }, null, 2);
  }

  _backupIfNeeded() {
    const day = new Date().toISOString().slice(0, 10);
    if (this._backupDay === day) return;
    this._backupDay = day;
    try {
      if (!fs.existsSync(this.file)) return;
      const bak = `${this.file}.bak-${day}`;
      if (!fs.existsSync(bak)) fs.copyFileSync(this.file, bak);
      const dir = path.dirname(this.file);
      const prefix = path.basename(this.file) + '.bak-';
      const old = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().slice(0, -BACKUPS_KEEP);
      for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    } catch (e) {
      console.error('Не удалось сделать резервную копию:', e?.message ?? e);
    }
  }

  async _flushLoop() {
    while (this._dirty) {
      this._dirty = false;
      const waiters = this._waiters;
      this._waiters = [];
      let error = null;
      try {
        this._backupIfNeeded();
        const tmp = `${this.file}.tmp`;
        await fs.promises.writeFile(tmp, this._serialize(), { mode: 0o600 });
        await fs.promises.rename(tmp, this.file);
      } catch (e) {
        error = e;
        console.error('Ошибка записи базы:', e?.message ?? e);
        this._dirty = true; // данные в памяти новее файла: повторим со следующей записью
        // Не крутимся в цикле на постоянной ошибке: ждём следующего save().
        for (const w of waiters) w.reject(error);
        break;
      }
      for (const w of waiters) w.resolve();
    }
    this._writing = null;
  }

  /**
   * Просит записать базу. Возвращаемое обещание выполняется, когда данные на диске.
   * Изменения, сделанные до вызова, попадут в запись; несколько вызовов подряд
   * объединяются в одну запись.
   */
  save() {
    this._dirty = true;
    const p = new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
    this._writing ??= this._flushLoop();
    return p;
  }

  /** Дождаться всех идущих записей (при остановке сервера). */
  async flush() {
    if (this._dirty) await this.save().catch(() => {});
    await this._writing;
  }
}
