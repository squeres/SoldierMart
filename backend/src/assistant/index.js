import { norm, stem, sameStem, keywords, SYNONYMS, detectCategory, CATEGORY_WORDS, parseBudget } from './text.js';
import { replies } from './replies.js';

/**
 * Помощник магазина без нейросети: разбирает запрос по правилам (русский и казахский),
 * ищет в каталоге, подбирает набор на сумму, рассказывает про баланс и заказы.
 * Если правила не поняли вопрос и подключена локальная модель (`llm`), вопрос уходит ей.
 *
 * Помощник ничего не меняет: он только читает данные человека, который вошёл, и предлагает
 * товары. Заказ оформляет сам человек в корзине. ИИН, ПИН и биометрия сюда не передаются.
 */

const MAX_LISTED = 6;
const MAX_BASKET_LINES = 8;

const lineOf = (p, lang, qty = 1) => ({
  id: p.id,
  name: lang === 'kk' ? p.nameKk : p.nameRu,
  price: p.price,
  qty,
  stock: p.stock,
});

function productStems(p) {
  const words = norm(`${p.nameRu} ${p.nameKk}`).split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w));
  return words.map(stem);
}

/** Слова запроса без служебных и без слов о цене/категории. */
function searchWords(msg) {
  const catWords = Object.values(CATEGORY_WORDS).flat();
  return keywords(msg).filter(
    (w) =>
      !/^(дешев|недорог|арзан|дорог|қымбат|самы|подороже|подешевле)/.test(w) &&
      !catWords.some((c) => w === c || (c.length >= 5 && w.startsWith(c.slice(0, 5)))),
  );
}

/** Товары, подходящие под запрос, лучшие первыми. */
function searchProducts(products, msg, category) {
  const words = searchWords(msg);
  if (!words.length) return [];
  const query = []; // [корень, вес]
  for (const w of words) {
    const s = stem(w);
    query.push([s, 2]);
    for (const [key, extra] of Object.entries(SYNONYMS)) {
      if (sameStem(s, key)) for (const e of extra) query.push([stem(e), 1]);
    }
  }
  const scored = [];
  for (const p of products) {
    if (category && p.category !== category) continue;
    const ps = productStems(p);
    let score = 0;
    for (const [qs, weight] of query) if (ps.some((x) => sameStem(x, qs))) score += weight;
    if (score > 0) scored.push({ p, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.p.price - b.p.price).map((x) => x.p);
}

/** Набор на сумму: по кругу берём разные товары из разных категорий, потом докупаем недорогое. */
function buildBasket(products, budget, category) {
  const pool = products.filter((p) => p.stock > 0 && p.price <= budget && (!category || p.category === category));
  const byCat = new Map();
  for (const p of [...pool].sort((a, b) => a.price - b.price)) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }
  const lines = [];
  let left = budget;
  for (let round = 0; lines.length < MAX_BASKET_LINES; round++) {
    let added = false;
    for (const list of byCat.values()) {
      const p = list[round];
      if (p && p.price <= left && lines.length < MAX_BASKET_LINES) {
        lines.push({ p, qty: 1 });
        left -= p.price;
        added = true;
      }
    }
    if (!added) break;
  }
  // Недорогое (расходное) можно взять по несколько штук, пока хватает денег.
  for (const l of lines) {
    while (l.p.price <= 1000 && l.qty < 3 && l.qty < l.p.stock && l.p.price <= left) {
      l.qty++;
      left -= l.p.price;
    }
  }
  return { lines, total: budget - left, left };
}

/**
 * Товары, которые выбрала модель, приводим к реальным: берём только существующие и имеющиеся в наличии,
 * количество ограничиваем остатком, а сумму урезаем до `cap` (маленькие модели плохо считают,
 * поэтому деньги проверяет сервер, а не модель).
 */
export function shapeLlmItems(picked, products, cap) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines = [];
  const seen = new Set();
  for (const it of Array.isArray(picked) ? picked : []) {
    const p = byId.get(String(it?.id));
    if (!p || seen.has(p.id) || p.stock <= 0 || lines.length >= MAX_BASKET_LINES) continue;
    seen.add(p.id);
    const qty = Math.max(1, Math.min(3, Math.floor(Number(it.qty) || 1), p.stock));
    lines.push({ p, qty });
  }
  const sum = () => lines.reduce((a, l) => a + l.p.price * l.qty, 0);
  while (lines.length && sum() > cap) {
    const last = lines[lines.length - 1];
    if (last.qty > 1) last.qty--;
    else lines.pop();
  }
  return { lines, total: sum() };
}

/**
 * Если модель назвала товары в тексте, но не вернула список кодов (так бывает у маленьких моделей),
 * находим эти товары в каталоге по названиям.
 */
export function itemsFromText(text, products) {
  const textStems = norm(text)
    .split(' ')
    .filter((w) => w.length > 1)
    .map(stem);
  const found = [];
  for (const p of products) {
    const words = norm(p.nameRu.split(',')[0])
      .split(' ')
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
      .map(stem);
    if (!words.length) continue;
    const hits = words.filter((w) => textStems.some((x) => sameStem(x, w)));
    if (hits.length / words.length >= 0.5) found.push({ id: p.id, qty: 1 });
    if (found.length >= MAX_BASKET_LINES) break;
  }
  return found;
}

/** Из текста модели убираем предложения с числами и ценами: цены и сумму показывает сервер. */
function withoutNumbers(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/\d|₸|тенге|тг\b/i.test(s))
    .join(' ')
    .trim();
}

const RE = {
  thanks: /(^| )(спасибо|благодар\w*|рахмет)( |$)/,
  greet: /^(привет\w*|здравств\w*|добрый (день|вечер|утро)|салем|сәлем|сэлем|хай|hello|hi)( |$)/,
  help: /(помощ|что (ты |вы )?(умеешь|можешь|умеете|можете)|команд|көмек|не істей)/,
  balance: /(баланс|сколько (у меня )?(денег|средств|осталось)|остаток (на )?сч|на сч[её]т|мой сч[её]т|ақшам|қанша (ақша|теңге)|шотымда)/,
  howOrder: /(как (оформить|заказать|купить|сделать заказ|пользоваться)|қалай (тапсырыс|сатып))/,
  pickup: /(как (получить|забрать)|где (получить|забрать)|выдач|код выдачи|қалай ал|алу тәртібі)/,
  basket: /(набор|собери|подбери|составь|на сумму|что (купить|взять)|жиынтық|алуға болады|алсам болады)/,
  recommend: /(что (купить|взять|выбрать)|посоветуй\w*|порекомендуй\w*|не алам|кеңес)/,
  cheap: /(дешев|недорог|арзан|подешевле)/,
  expensive: /(^| )(дорог\w*|подороже|қымбат\w*)/,
  // Человек просит подборку товаров (а не, например, анекдот): только тогда показываем товары от модели.
  select: /(подбер|посовету|порекоменду|списк|набор|составь|покажи|предложи|что (купить|взять|есть|выбрать)|хочу|нужн|керек|таңда|көрсет|ұсын)/,
};

export function createAssistant({ llm = null } = {}) {
  /**
   * @param {{lang: string, message: string,
   *   products: Array<{id,nameRu,nameKk,category,price,stock}>,
   *   user: {name: string, balance: number},
   *   orders: Array<{code,total,status}>}} ctx
   * @returns {Promise<{reply: string, suggestions: string[], products: object[], cart: object[]|null, source: 'rules'|'llm'}>}
   */
  async function answer(ctx) {
    const lang = ctx.lang === 'kk' ? 'kk' : 'ru';
    const r = replies(lang);
    const t = norm(ctx.message);
    const out = (reply, extra = {}) => ({
      reply,
      suggestions: r.chips,
      products: [],
      cart: null,
      source: 'rules',
      ...extra,
    });
    const list = (items) => items.slice(0, MAX_LISTED).map((p) => lineOf(p, lang));
    const inStock = ctx.products.filter((p) => p.stock > 0);

    if (RE.thanks.test(t)) return out(r.thanks);
    if (RE.greet.test(t) && t.split(' ').length <= 3) return out(r.greet(ctx.user.name?.split(' ')[0]));
    if (RE.help.test(t)) return out(r.help);

    if (RE.howOrder.test(t)) return out(r.howOrder);

    const words = t.split(' ');
    const mentionsOrders =
      words.some((w) => /^заказ(ы|ов|а|у|е)?$/.test(w)) || words.some((w) => /^тапсырыс/.test(w));
    if (RE.pickup.test(t) || (mentionsOrders && !RE.basket.test(t))) {
      const ready = ctx.orders.filter((o) => o.status === 'ready');
      const parts = [];
      if (RE.pickup.test(t)) parts.push(r.pickup);
      if (ready.length) parts.push(...ready.slice(0, 3).map((o) => r.orderReady(o.code, o.total)));
      else if (ctx.orders.length) parts.push(r.orderLast(r.status[ctx.orders[0].status] ?? '', ctx.orders[0].total));
      else if (!RE.pickup.test(t)) parts.push(r.ordersNone);
      return out(parts.join('\n'));
    }

    if (RE.balance.test(t) && !RE.basket.test(t)) return out(r.balance(ctx.user.balance));

    const category = detectCategory(ctx.message);
    const budget = parseBudget(ctx.message);

    // Вопрос уходит модели. Она выбирает товары по кодам, а карточки и цены строит сервер.
    const viaLlm = async () => {
      try {
        const res = await llm.ask({ lang, message: ctx.message, products: inStock, user: ctx.user });
        const text = typeof res === 'string' ? res : (res?.text ?? '');
        const cap = Math.min(budget ?? Infinity, ctx.user.balance);
        // Маленькая модель любит «советовать товары» даже на анекдот: карточки показываем только по просьбе.
        const wantsList = Boolean(category) || RE.select.test(t);
        let picked = wantsList && typeof res !== 'string' ? (res?.items ?? []) : [];
        if (wantsList && !picked.length) picked = itemsFromText(text, inStock);
        const { lines, total } = shapeLlmItems(picked, inStock, cap);
        if (lines.length) {
          const head = withoutNumbers(text) || r.llmPicked;
          return out(`${head}\n${r.llmTotal(total)}`, {
            source: 'llm',
            products: lines.map((l) => lineOf(l.p, lang, l.qty)),
            cart: lines.length >= 2 ? lines.map((l) => ({ productId: l.p.id, qty: l.qty })) : null,
          });
        }
        if (text) return out(text.slice(0, 600), { source: 'llm' });
        return out(r.unknown + '\n' + r.help);
      } catch {
        /* модель недоступна: отвечаем как без неё */
      }
      return out(r.llmDown);
    };

    // «Посоветуй/подбери» без суммы. Если правила знают, о чём речь («что-нибудь тёплое»),
    // они точнее маленькой модели; иначе вопрос уходит модели, а без неё просим назвать сумму.
    const noBudget = () => {
      const known = category ? [] : searchProducts(ctx.products, ctx.message, null).filter((p) => p.stock > 0);
      if (known.length) return out(r.found(Math.min(known.length, MAX_LISTED)), { products: list(known) });
      return llm ? viaLlm() : out(r.needBudget);
    };

    // Набор на сумму: правила считают точно, поэтому при названной сумме модель не нужна.
    const wantsBasket =
      RE.basket.test(t) ||
      (budget && (RE.recommend.test(t) || category)) ||
      (budget && /(^| )(на|до|за|в пределах)( |$)/.test(t) && !searchWords(ctx.message).length);
    if (wantsBasket) {
      if (!budget) return noBudget();
      const capped = budget > ctx.user.balance;
      const usable = capped ? ctx.user.balance : budget;
      const { lines, total, left } = buildBasket(ctx.products, usable, category);
      if (!lines.length) return out(capped && usable === 0 ? r.balance(0) : r.basketEmpty);
      const head = r.basket(usable, total, left);
      return out(capped ? `${r.basketCapped(ctx.user.balance)}\n${head}` : head, {
        products: lines.map((l) => lineOf(l.p, lang, l.qty)),
        cart: lines.map((l) => ({ productId: l.p.id, qty: l.qty })),
      });
    }
    if (RE.recommend.test(t)) return noBudget();

    // Поиск по словам.
    const found = searchProducts(ctx.products, ctx.message, category);
    if (found.length) {
      const avail = found.filter((p) => p.stock > 0);
      const gone = found.filter((p) => p.stock <= 0);
      if (!avail.length) return out(r.soldOut(gone.slice(0, 3).map((p) => (lang === 'kk' ? p.nameKk : p.nameRu)).join(', ')));
      let sorted = avail;
      let head = r.found(Math.min(avail.length, MAX_LISTED));
      if (RE.cheap.test(t)) {
        sorted = [...avail].sort((a, b) => a.price - b.price);
        head = r.foundCheap;
      } else if (RE.expensive.test(t)) {
        sorted = [...avail].sort((a, b) => b.price - a.price);
        head = r.foundExpensive;
      }
      const note = gone.length ? `\n${r.soldOut(gone.slice(0, 3).map((p) => (lang === 'kk' ? p.nameKk : p.nameRu)).join(', '))}` : '';
      return out(head + note, { products: list(sorted) });
    }

    // Только категория («что есть из еды»).
    if (category && !searchWords(ctx.message).length) {
      let items = [...inStock.filter((p) => p.category === category)];
      items.sort((a, b) => (RE.expensive.test(t) ? b.price - a.price : a.price - b.price));
      if (items.length) return out(r.category(r.categories[category]), { products: list(items) });
    }

    // Не поняли: пробуем локальную модель, если она подключена.
    if (llm) return viaLlm();
    // «Нет такого товара» говорим только если это похоже на просьбу о товаре, иначе показываем возможности.
    const looksLikeProduct =
      words.length <= 3 ||
      /(^| )(хочу|нужн\w*|есть|купить|найди|найдите|покажи|где|ищу|керек|бар ма|іздеймін)( |$)/.test(t);
    return searchWords(ctx.message).length && looksLikeProduct
      ? out(r.notFound)
      : out(r.unknown + '\n' + r.help);
  }

  return { answer };
}
