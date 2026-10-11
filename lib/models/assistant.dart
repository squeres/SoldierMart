/// Товар в ответе помощника (`POST /api/assistant`).
class AssistantItem {
  const AssistantItem({
    required this.id,
    required this.name,
    required this.price,
    required this.qty,
    required this.stock,
  });

  factory AssistantItem.fromJson(Map<String, dynamic> j) => AssistantItem(
        id: j['id'] as String,
        name: j['name'] as String,
        price: (j['price'] as num).toInt(),
        qty: (j['qty'] as num?)?.toInt() ?? 1,
        stock: (j['stock'] as num?)?.toInt() ?? 0,
      );

  final String id;
  final String name;
  final int price;

  /// Сколько штук предлагает помощник (для набора на сумму).
  final int qty;
  final int stock;
}

/// Ответ помощника.
class AssistantReply {
  const AssistantReply({
    required this.reply,
    this.suggestions = const [],
    this.products = const [],
    this.cart,
  });

  factory AssistantReply.fromJson(Map<String, dynamic> j) => AssistantReply(
        reply: j['reply'] as String? ?? '',
        suggestions: [...((j['suggestions'] as List?) ?? const []).cast<String>()],
        products: [
          for (final p in ((j['products'] as List?) ?? const []).cast<Map<String, dynamic>>())
            AssistantItem.fromJson(p),
        ],
        // Готовый набор «добавить всё в корзину»; null, если помощник его не предлагает.
        cart: j['cart'] == null
            ? null
            : [
                for (final c in (j['cart'] as List).cast<Map<String, dynamic>>())
                  AssistantItem(
                    id: c['productId'] as String,
                    name: '',
                    price: 0,
                    qty: (c['qty'] as num).toInt(),
                    stock: 0,
                  ),
              ],
      );

  final String reply;
  final List<String> suggestions;
  final List<AssistantItem> products;
  final List<AssistantItem>? cart;
}

/// Сообщение в чате с помощником. Живёт только в памяти до выхода из аккаунта.
class ChatMessage {
  const ChatMessage.user(this.text)
      : fromUser = true,
        products = const [],
        cart = null,
        suggestions = const [];

  const ChatMessage.bot(
    this.text, {
    this.products = const [],
    this.cart,
    this.suggestions = const [],
  }) : fromUser = false;

  final bool fromUser;
  final String text;
  final List<AssistantItem> products;
  final List<AssistantItem>? cart;
  final List<String> suggestions;
}
