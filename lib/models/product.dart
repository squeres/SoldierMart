import 'package:flutter/material.dart';

import '../data/catalog.dart';

enum Category { food, hygiene, clothing, stationery }

class Product {
  const Product({
    required this.id,
    required this.nameRu,
    required this.nameKk,
    required this.category,
    required this.price,
    required this.icon,
    required this.stock,
  });

  /// Товар из ответа сервера (`GET /api/catalog`).
  factory Product.fromJson(Map<String, dynamic> j) => Product(
        id: j['id'] as String,
        nameRu: j['nameRu'] as String,
        nameKk: j['nameKk'] as String,
        category: Category.values.firstWhere(
          (c) => c.name == j['category'],
          orElse: () => Category.stationery,
        ),
        price: (j['price'] as num).toInt(),
        icon: kIcons[j['icon']] ?? Icons.shopping_bag,
        stock: (j['stock'] as num).toInt(),
      );

  final String id;
  final String nameRu;
  final String nameKk;
  final Category category;

  /// Цена в тенге.
  final int price;
  final IconData icon;

  /// Остаток на складе на момент последней загрузки каталога.
  final int stock;

  String name(String lang) => lang == 'kk' ? nameKk : nameRu;
}

class CartLine {
  CartLine(this.product, this.qty);
  final Product product;
  int qty;
  int get total => product.price * qty;
}

/// Вошедший военнослужащий. ИИН и ПИН на устройстве не хранятся.
class Soldier {
  const Soldier({required this.name, required this.unit});

  final String name;
  final String unit;
}
