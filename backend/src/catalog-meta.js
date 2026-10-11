/**
 * Допустимые значения для товаров. Категории и значки должен знать и клиент:
 * категории в `lib/models/product.dart` (enum Category), значки в `lib/data/catalog.dart` (kIcons).
 * Добавляя сюда значение, добавьте его и в приложение, иначе там покажется значок по умолчанию.
 */
export const CATEGORIES = [
  { id: 'food', ru: 'Еда' },
  { id: 'hygiene', ru: 'Гигиена' },
  { id: 'clothing', ru: 'Одежда' },
  { id: 'stationery', ru: 'Прочее' },
];

export const ICONS = [
  'cookie', 'icecream', 'emoji_food_beverage', 'coffee', 'ramen_dining', 'lunch_dining', 'bakery_dining',
  'water_drop', 'clean_hands', 'brush', 'cleaning_services', 'content_cut', 'shower', 'dry_cleaning',
  'checkroom', 'ac_unit', 'back_hand', 'menu_book', 'edit', 'mail', 'battery_full',
  'local_drink', 'fastfood', 'restaurant', 'cake', 'medical_services', 'flashlight_on', 'umbrella',
  'inventory_2', 'shopping_bag', 'local_cafe',
];
