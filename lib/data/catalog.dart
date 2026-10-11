import 'package:flutter/material.dart';

/// Каталог и пользователи теперь приходят с сервера. Здесь осталось только
/// соответствие ключей значков из ответа сервера (`icon`) значкам Flutter.
const Map<String, IconData> kIcons = {
  'cookie': Icons.cookie,
  'icecream': Icons.icecream,
  'emoji_food_beverage': Icons.emoji_food_beverage,
  'coffee': Icons.coffee,
  'ramen_dining': Icons.ramen_dining,
  'lunch_dining': Icons.lunch_dining,
  'bakery_dining': Icons.bakery_dining,
  'water_drop': Icons.water_drop,
  'clean_hands': Icons.clean_hands,
  'brush': Icons.brush,
  'cleaning_services': Icons.cleaning_services,
  'content_cut': Icons.content_cut,
  'shower': Icons.shower,
  'dry_cleaning': Icons.dry_cleaning,
  'checkroom': Icons.checkroom,
  'ac_unit': Icons.ac_unit,
  'back_hand': Icons.back_hand,
  'menu_book': Icons.menu_book,
  'edit': Icons.edit,
  'mail': Icons.mail,
  'battery_full': Icons.battery_full,
  // Значки, которые дежурный может выбрать для новых товаров (список в backend/src/catalog-meta.js).
  'local_drink': Icons.local_drink,
  'fastfood': Icons.fastfood,
  'restaurant': Icons.restaurant,
  'cake': Icons.cake,
  'medical_services': Icons.medical_services,
  'flashlight_on': Icons.flashlight_on,
  'umbrella': Icons.umbrella,
  'inventory_2': Icons.inventory_2,
  'shopping_bag': Icons.shopping_bag,
  'local_cafe': Icons.local_cafe,
};
