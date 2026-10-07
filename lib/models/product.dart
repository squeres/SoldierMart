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

/// Статус заказа на сервере.
enum OrderStatus { ready, pickedUp, cancelled }

class OrderLineRecord {
  const OrderLineRecord({
    required this.nameRu,
    required this.nameKk,
    required this.price,
    required this.qty,
  });

  factory OrderLineRecord.fromJson(Map<String, dynamic> j) => OrderLineRecord(
        nameRu: j['nameRu'] as String,
        nameKk: j['nameKk'] as String,
        price: (j['price'] as num).toInt(),
        qty: (j['qty'] as num).toInt(),
      );

  final String nameRu;
  final String nameKk;
  final int price;
  final int qty;

  String name(String lang) => lang == 'kk' ? nameKk : nameRu;
}

/// Заказ из истории (`GET /api/orders`). Сервер отдаёт только заказы вошедшего человека.
class OrderRecord {
  const OrderRecord({
    required this.id,
    required this.code,
    required this.total,
    required this.status,
    required this.createdAt,
    required this.items,
  });

  factory OrderRecord.fromJson(Map<String, dynamic> j) => OrderRecord(
        id: j['id'] as String,
        code: j['code'] as String,
        total: (j['total'] as num).toInt(),
        status: switch (j['status']) {
          'picked_up' => OrderStatus.pickedUp,
          'cancelled' => OrderStatus.cancelled,
          _ => OrderStatus.ready,
        },
        createdAt: DateTime.tryParse(j['createdAt'] as String? ?? '')?.toLocal() ??
            DateTime.fromMillisecondsSinceEpoch(0),
        items: [
          for (final i in (j['items'] as List).cast<Map<String, dynamic>>())
            OrderLineRecord.fromJson(i),
        ],
      );

  final String id;

  /// Код выдачи. Имеет смысл только пока заказ [OrderStatus.ready].
  final String code;
  final int total;
  final OrderStatus status;
  final DateTime createdAt;
  final List<OrderLineRecord> items;
}
