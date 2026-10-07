import { hashPin } from './pin.js';

// Начальные данные для демо. Выдаются один раз при создании базы.

export const PRODUCTS = [
  // Еда
  { id: 'f1', nameRu: 'Печенье овсяное, 300 г', nameKk: 'Сұлы печеньесі, 300 г', category: 'food', price: 650, icon: 'cookie', stock: 120 },
  { id: 'f2', nameRu: 'Сгущённое молоко, 380 г', nameKk: 'Қоюлатылған сүт, 380 г', category: 'food', price: 720, icon: 'icecream', stock: 80 },
  { id: 'f3', nameRu: 'Чай чёрный, 100 пак.', nameKk: 'Қара шай, 100 пакет', category: 'food', price: 1100, icon: 'emoji_food_beverage', stock: 60 },
  { id: 'f4', nameRu: 'Кофе 3-в-1, 20 шт.', nameKk: 'Кофе 3-в-1, 20 дана', category: 'food', price: 1350, icon: 'coffee', stock: 70 },
  { id: 'f5', nameRu: 'Лапша быстрого приготовления', nameKk: 'Жылдам дайындалатын кеспе', category: 'food', price: 280, icon: 'ramen_dining', stock: 200 },
  { id: 'f6', nameRu: 'Тушёнка говяжья, 325 г', nameKk: 'Сиыр еті консервісі, 325 г', category: 'food', price: 1450, icon: 'lunch_dining', stock: 90 },
  { id: 'f7', nameRu: 'Курт, 200 г', nameKk: 'Құрт, 200 г', category: 'food', price: 900, icon: 'bakery_dining', stock: 50 },
  { id: 'f8', nameRu: 'Вода питьевая, 1,5 л', nameKk: 'Ауыз су, 1,5 л', category: 'food', price: 220, icon: 'water_drop', stock: 300 },
  // Гигиена
  { id: 'h1', nameRu: 'Мыло туалетное', nameKk: 'Дәретхана сабыны', category: 'hygiene', price: 250, icon: 'clean_hands', stock: 150 },
  { id: 'h2', nameRu: 'Зубная паста', nameKk: 'Тіс пастасы', category: 'hygiene', price: 690, icon: 'brush', stock: 110 },
  { id: 'h3', nameRu: 'Зубная щётка', nameKk: 'Тіс щеткасы', category: 'hygiene', price: 350, icon: 'cleaning_services', stock: 140 },
  { id: 'h4', nameRu: 'Бритвенный станок, 3 шт.', nameKk: 'Қырынатын станок, 3 дана', category: 'hygiene', price: 1200, icon: 'content_cut', stock: 75 },
  { id: 'h5', nameRu: 'Шампунь, 250 мл', nameKk: 'Шампунь, 250 мл', category: 'hygiene', price: 980, icon: 'shower', stock: 65 },
  { id: 'h6', nameRu: 'Полотенце', nameKk: 'Орамал', category: 'hygiene', price: 1500, icon: 'dry_cleaning', stock: 40 },
  // Одежда и обувь
  { id: 'c1', nameRu: 'Носки хлопковые, 5 пар', nameKk: 'Мақта шұлық, 5 жұп', category: 'clothing', price: 1600, icon: 'checkroom', stock: 100 },
  { id: 'c2', nameRu: 'Термобельё (комплект)', nameKk: 'Термокиім (жиынтық)', category: 'clothing', price: 6500, icon: 'ac_unit', stock: 30 },
  { id: 'c3', nameRu: 'Перчатки зимние', nameKk: 'Қысқы қолғап', category: 'clothing', price: 2400, icon: 'back_hand', stock: 45 },
  // Канцелярия и прочее
  { id: 's1', nameRu: 'Тетрадь 48 л.', nameKk: 'Дәптер 48 п.', category: 'stationery', price: 180, icon: 'menu_book', stock: 200 },
  { id: 's2', nameRu: 'Ручки шариковые, 5 шт.', nameKk: 'Шарикті қалам, 5 дана', category: 'stationery', price: 400, icon: 'edit', stock: 180 },
  { id: 's3', nameRu: 'Конверты с марками, 5 шт.', nameKk: 'Маркалы конверттер, 5 дана', category: 'stationery', price: 500, icon: 'mail', stock: 100 },
  { id: 's4', nameRu: 'Батарейки AA, 4 шт.', nameKk: 'AA батареялары, 4 дана', category: 'stationery', price: 750, icon: 'battery_full', stock: 90 },
];

// Вымышленные ИИН (проходят проверку контрольной цифры).
const DEMO_USERS = [
  { iin: '030515501234', pin: '1234', name: 'Серик Алимов', unit: 'в/ч 12345, Астана', balance: 25000 },
  { iin: '980107304562', pin: '4321', name: 'Дархан Нурпеисов', unit: 'в/ч 54321, Караганда', balance: 8000 },
];

export async function seedData() {
  const users = {};
  for (const u of DEMO_USERS) {
    users[u.iin] = {
      iin: u.iin,
      name: u.name,
      unit: u.unit,
      balance: u.balance,
      ...(await hashPin(u.pin)),
    };
  }
  return {
    users,
    products: structuredClone(PRODUCTS),
    favorites: {},
    orders: [],
    ledger: [],
    faceTemplates: {},
    security: { locked: {}, pinFails: {}, faceFails: {}, strikes: {} },
  };
}
