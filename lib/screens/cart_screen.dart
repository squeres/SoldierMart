import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../state/app_state.dart';
import 'success_screen.dart';

class CartScreen extends StatelessWidget {
  const CartScreen({super.key});

  /// Заказ оформляет сервер: он списывает деньги и выдаёт код.
  Future<void> _checkout(BuildContext context, AppState app) async {
    final r = await app.placeOrder();
    if (!context.mounted) return;

    if (r.ok) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => SuccessScreen(code: r.code!)),
      );
      return;
    }

    final f = r.failure;
    if (f == OrderFailure.sessionExpired) return; // приложение само вернётся на экран входа
    var key = 'serverError';
    if (f == OrderFailure.insufficientFunds) {
      key = 'notEnough';
    } else if (f == OrderFailure.outOfStock) {
      key = 'outOfStock';
    } else if (f == OrderFailure.network) {
      key = 'networkError';
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(app.s.t(key), style: const TextStyle(fontSize: 16))),
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final s = app.s;
    final cs = Theme.of(context).colorScheme;
    final lines = app.cartLines;

    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        title: Text(s.t('cart')),
        actions: [
          if (lines.isNotEmpty)
            TextButton.icon(
              onPressed: app.clearCart,
              icon: const Icon(Icons.delete_outline),
              label: Text(s.t('clear')),
            ),
          const SizedBox(width: 8),
        ],
      ),
      body: lines.isEmpty
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.shopping_cart_outlined, size: 72, color: cs.outline),
                  const SizedBox(height: 12),
                  Text(s.t('cartEmpty'),
                      style: Theme.of(context).textTheme.titleLarge),
                ],
              ),
            )
          : ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: lines.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (_, i) {
                final l = lines[i];
                final canAdd = l.qty < app.stockOf(l.product);
                return ListTile(
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  leading: CircleAvatar(
                    radius: 26,
                    backgroundColor: cs.primaryContainer,
                    child: Icon(l.product.icon, color: cs.onPrimaryContainer),
                  ),
                  title: Text(l.product.name(app.lang),
                      style: const TextStyle(fontSize: 17)),
                  subtitle: Text(
                      '${s.money(l.product.price)} × ${l.qty} = ${s.money(l.total)}',
                      style: const TextStyle(fontSize: 15)),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton.filledTonal(
                        iconSize: 28,
                        onPressed: () => app.remove(l.product),
                        icon: const Icon(Icons.remove),
                      ),
                      SizedBox(
                        width: 40,
                        child: Center(
                          child: Text('${l.qty}',
                              style: const TextStyle(
                                  fontSize: 20, fontWeight: FontWeight.bold)),
                        ),
                      ),
                      IconButton.filledTonal(
                        iconSize: 28,
                        onPressed: canAdd ? () => app.add(l.product) : null,
                        icon: const Icon(Icons.add),
                      ),
                    ],
                  ),
                );
              },
            ),
      bottomNavigationBar: lines.isEmpty
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(s.t('total'),
                            style: const TextStyle(fontSize: 22)),
                        Text(s.money(app.cartTotal),
                            style: const TextStyle(
                                fontSize: 26, fontWeight: FontWeight.bold)),
                      ],
                    ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(s.t('balance'),
                            style: TextStyle(color: cs.outline, fontSize: 16)),
                        Text(s.money(app.balance),
                            style: TextStyle(color: cs.outline, fontSize: 16)),
                      ],
                    ),
                    if (!app.canAfford)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(s.t('notEnough'),
                            style: TextStyle(color: cs.error, fontSize: 16)),
                      ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      height: 64,
                      child: FilledButton(
                        onPressed: app.canAfford && !app.placingOrder
                            ? () => _checkout(context, app)
                            : null,
                        child: app.placingOrder
                            ? const SizedBox(
                                width: 26,
                                height: 26,
                                child: CircularProgressIndicator(strokeWidth: 3),
                              )
                            : Text(s.t('checkout'),
                                style: const TextStyle(fontSize: 22)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}
