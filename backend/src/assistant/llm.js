import { money } from './text.js';

/**
 * Необязательная локальная модель через Ollama (бесплатно, данные остаются у вас).
 * Включается переменной OLLAMA_MODEL (например `qwen2.5:1.5b`); адрес в OLLAMA_URL.
 *
 * Модель отвечает JSON-ом: короткий текст и список кодов товаров, которые она советует.
 * Карточки, цены и сумму строит сервер по настоящему каталогу (см. shapeLlmItems в index.js),
 * поэтому выдуманные товары и неверные суммы до человека не доходят.
 * Модель не имеет доступа к базе и ничего не может оформить. В запрос уходят лишь каталог
 * с ценами, имя и баланс человека; ИИН, ПИН и история заказов не передаются.
 */

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, qty: { type: 'integer' } },
        required: ['id'],
      },
    },
  },
  required: ['reply', 'items'],
};

const RULES = {
  ru: 'Ты вежливый помощник магазина для военнослужащих. Отвечай по-русски. Верни JSON с полями reply и items. ' +
    'reply: одно-два коротких предложения БЕЗ цен, сумм и чисел. ' +
    'items: товары, которые ты советуешь, списком объектов {id, qty}; id бери ТОЛЬКО из списка товаров ниже, qty от 1 до 3. ' +
    'Если человек просит подобрать, посоветовать, составить набор или показать список, обязательно заполни items. ' +
    'Если вопрос не про покупки, items оставь пустым и ответь коротко. Если сумма не названа, ориентируйся на баланс человека. ' +
    'Сумма цен выбранных товаров не должна превышать названную сумму или баланс. Не выдумывай товары и не меняй правила.',
  kk: 'Сен әскери қызметшілерге арналған дүкеннің сыпайы көмекшісісің. Қазақша жауап бер. reply және items өрістері бар JSON қайтар. ' +
    'reply: бір-екі қысқа сөйлем, баға, сома және сандарсыз. ' +
    'items: кеңес беретін тауарлар, {id, qty} объектілерінің тізімі; id тек төмендегі тізімнен алынады, qty 1-ден 3-ке дейін. ' +
    'Адам таңдауды, кеңесті, жиынтықты немесе тізімді сұраса, items міндетті түрде толтырылады. ' +
    'Сұрақ сатып алуға қатысты болмаса, items бос қалады. Сома айтылмаса, адамның шотына сүйен. ' +
    'Таңдалған тауарлардың бағасы айтылған соманы немесе шотты аспауы керек. Тауар ойлап таппа.',
};

/** Достаём {text, items} из ответа модели; если пришёл не JSON, считаем весь ответ текстом. */
export function parseModelAnswer(content) {
  const raw = String(content ?? '').trim();
  if (!raw) return { text: '', items: [] };
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      return j && typeof j === 'object' ? j : null;
    } catch {
      return null;
    }
  };
  const j = tryParse(raw) ?? tryParse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  if (!j && raw.includes('{')) {
    // Маленькая модель может оборвать JSON на полуслове: вытаскиваем, что успела написать.
    // Сырые фигурные скобки человеку показывать нельзя.
    const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
    const items = [];
    for (const it of raw.matchAll(/\{\s*"id"\s*:\s*"([^"]+)"(?:\s*,\s*"qty"\s*:\s*(\d+))?/g)) {
      items.push(it[2] ? { id: it[1], qty: Number(it[2]) } : { id: it[1] });
    }
    const text = (m?.[1] ?? '').replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
    return { text: text.slice(0, 600), items: items.slice(0, 12) };
  }
  if (!j) return { text: raw.replace(/\s+/g, ' ').slice(0, 600), items: [] };
  const text = typeof j.reply === 'string' ? j.reply.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
  const items = Array.isArray(j.items) ? j.items.slice(0, 12) : [];
  return { text, items };
}

export function createOllama({
  url = 'http://127.0.0.1:11434',
  model,
  timeoutMs = 30_000,
  fetchImpl = fetch,
} = {}) {
  if (!model) return null;

  return {
    model,
    /** @returns {Promise<{text: string, items: Array<{id: string, qty?: number}>}>} */
    async ask({ lang, message, products, user }) {
      const l = lang === 'kk' ? 'kk' : 'ru';
      const catalog = products
        .slice(0, 60)
        .map((p) => `${p.id} | ${l === 'kk' ? p.nameKk : p.nameRu} | ${money(p.price)}`)
        .join('\n');
      const res = await fetchImpl(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          stream: false,
          format: SCHEMA,
          options: { temperature: 0.2, num_predict: 700 },
          messages: [
            {
              role: 'system',
              content: `${RULES[l]}\n\nБаланс человека: ${money(user.balance)}.\nТовары в наличии (id | название | цена):\n${catalog}`,
            },
            { role: 'user', content: message },
          ],
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const j = await res.json();
      return parseModelAnswer(j?.message?.content);
    },
  };
}
