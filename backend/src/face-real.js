import { createRequire } from 'node:module';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);

/**
 * Настоящее распознавание лица на сервере.
 *
 * Как это работает: нейросеть (face-api, модели лежат в пакете) находит лицо
 * на снимке и превращает его в «шаблон» — 128 чисел. Сам снимок сразу
 * выбрасывается. При входе шаблон нового снимка сравнивается с шаблонами,
 * записанными для этого ИИН; если расстояние меньше порога, это тот же человек.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: проверки «живости». Фотография человека (в том числе
 * на экране телефона), поднесённая к камере, может пройти проверку.
 * Для защиты от этого нужна отдельная модель anti-spoofing или
 * камера с глубиной / ИК.
 */

// Расстояние между шаблонами одного человека обычно 0.2–0.45, разных людей
// 0.6 и больше, но у непохожих ракурсов бывает и 0.5. Поэтому порог 0.45: строже стандартных 0.6, чужого пускает реже,
// а хозяина при плохом свете может иногда не узнать (это не страшно: 3 попытки).
const DEFAULT_THRESHOLD = 0.45;
const MAX_SIDE = 640; // большие снимки уменьшаем: быстрее и результат тот же
const MIN_DETECTION_SCORE = 0.6;
const MIN_FACE_WIDTH_RATIO = 0.18; // лицо должно занимать хотя бы 18% ширины кадра
const MAX_PIXELS = 25_000_000; // защита от «бомб» (огромное изображение в малом файле)

export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Простая очередь: нейросеть обрабатывает снимки по одному. */
class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}

function decode(buf) {
  // Формат определяем по первым байтам, а не по тому, что заявил клиент.
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 });
    return { width: img.width, height: img.height, rgba: img.data };
  }
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const img = PNG.sync.read(buf);
    return { width: img.width, height: img.height, rgba: img.data };
  }
  return null;
}

/** Уменьшение усреднением блоков до MAX_SIDE по большей стороне. */
function downscale({ width, height, rgba }) {
  const k = Math.max(width, height) / MAX_SIDE;
  if (k <= 1) return { width, height, rgba };
  const w = Math.max(1, Math.round(width / k));
  const h = Math.max(1, Math.round(height / k));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * width + xx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, rgba: out };
}

export class RealFaceVerifier {
  /**
   * @param {{threshold?: number}} [opts]
   */
  constructor({ threshold = DEFAULT_THRESHOLD, liveness = null } = {}) {
    this.isDemo = false;
    this.threshold = threshold;
    /**
     * Необязательная проверка «живости»: объект с методом `async check(image: Buffer) -> boolean`
     * (модель anti-spoofing, ИК/глубина с терминала и т. п.). Если он задан и вернул false,
     * вход считается неудачным (noMatch, попытка списывается). Готовой модели в проекте нет.
     */
    this.liveness = liveness;
    this.ready = false;
    this._lock = new Mutex();
  }

  /** Загрузка нейросети. Вызывается один раз при старте сервера. */
  async init() {
    const tf = require('@tensorflow/tfjs');
    const wasm = require('@tensorflow/tfjs-backend-wasm');
    const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');

    // Файлы WASM берём из локальной папки пакета, интернет не нужен.
    const wasmDir = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json'));
    wasm.setWasmPaths(path.join(wasmDir, 'dist') + path.sep, false);
    await tf.setBackend('wasm');
    await tf.ready();

    const modelDir = path.join(
      path.dirname(require.resolve('@vladmandic/face-api/package.json')),
      'model',
    );
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);

    this.tf = tf;
    this.faceapi = faceapi;
    this.options = new faceapi.SsdMobilenetv1Options({
      minConfidence: MIN_DETECTION_SCORE,
      maxResults: 5,
    });
    this.ready = true;
    return this;
  }

  /**
   * Шаблон лица из снимка.
   * @returns {Promise<{status:'ok', descriptor:number[]} | {status:'noFace'|'multiple'|'badImage'}>}
   */
  extract(image) {
    return this._lock.run(() => this._extract(image));
  }

  async _extract(image) {
    if (!this.ready) throw new Error('face engine not initialised');
    let raw;
    try {
      raw = decode(image);
    } catch {
      return { status: 'badImage' };
    }
    if (!raw || raw.width * raw.height > MAX_PIXELS || raw.width < 64 || raw.height < 64) {
      return { status: 'badImage' };
    }
    const { width, height, rgba } = downscale(raw);

    const { tf, faceapi } = this;
    const rgb = new Int32Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    const tensor = tf.tensor3d(rgb, [height, width, 3], 'int32');
    try {
      const found = await faceapi
        .detectAllFaces(tensor, this.options)
        .withFaceLandmarks()
        .withFaceDescriptors();

      // Слишком маленькие лица (человек далеко или это случайный прохожий) игнорируем.
      const faces = found.filter(
        (f) => f.detection.box.width >= width * MIN_FACE_WIDTH_RATIO,
      );
      if (faces.length === 0) return { status: 'noFace' };
      if (faces.length > 1) return { status: 'multiple' };
      return { status: 'ok', descriptor: Array.from(faces[0].descriptor) };
    } finally {
      tf.dispose(tensor);
    }
  }

  /**
   * Решение для входа.
   * @returns {Promise<'match'|'noMatch'|'noFace'|'error'>}
   * Всё неопределённое (нет шаблона, плохой снимок, сбой) никогда не даёт 'match'.
   */
  async verify({ image, templates }) {
    if (!Array.isArray(templates) || templates.length === 0) return 'error';
    let r;
    try {
      r = await this.extract(image);
    } catch {
      return 'error';
    }
    if (r.status === 'noFace') return 'noFace';
    if (r.status !== 'ok') return 'error'; // несколько лиц или битый снимок: попытку не списываем

    if (this.liveness) {
      let alive = false;
      try {
        alive = (await this.liveness.check(image)) === true;
      } catch {
        alive = false; // сбой проверки живости никогда не открывает вход
      }
      if (!alive) return 'noMatch';
    }

    let best = Infinity;
    for (const t of templates) {
      if (!Array.isArray(t) || t.length !== r.descriptor.length) continue;
      best = Math.min(best, distance(r.descriptor, t));
    }
    return best <= this.threshold ? 'match' : 'noMatch';
  }
}
