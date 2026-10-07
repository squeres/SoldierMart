/**
 * Проверка лица. Решение «свой/чужой» принимает только сервер.
 *
 * Интерфейс: verify({ iin, image: Buffer }) -> 'match' | 'noMatch' | 'noFace' | 'error'
 *
 * Для боевого запуска нужна реализация, которая сравнивает лицо с эталонным
 * шаблоном этого ИИН, проверяет «живость» (защита от фото на экране телефона)
 * и не сохраняет сам снимок. При любой неопределённости она должна
 * возвращать 'noMatch' или 'error', но никогда не 'match'.
 */

/**
 * ДЕМО-ЗАГЛУШКА. Не распознаёт лицо и пропускает любого, у кого пришёл
 * непустой снимок, поэтому защиты от кражи аккаунта НЕ даёт.
 *
 * Чтобы проверить блокировку по лицу, запустите сервер с переменной
 * FACE_DEMO_RESULT=noMatch (или noFace / error).
 */
export class DemoFaceVerifier {
  constructor({ forced } = {}) {
    this.isDemo = true;
    this.forced = ['match', 'noMatch', 'noFace', 'error'].includes(forced)
      ? forced
      : null;
  }

  async verify({ image }) {
    if (this.forced) return this.forced;
    return image && image.length > 0 ? 'match' : 'noFace';
  }
}
