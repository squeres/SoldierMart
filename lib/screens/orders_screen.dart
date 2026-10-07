import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../models/product.dart';
import '../state/app_state.dart';

/// История заказов вошедшего человека. Данные приходят с сервера и привязаны к его ИИН:
/// чужих заказов здесь быть не может.
class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  @override
  void initState() {
    super.initState();
    // Загружаем после первой отрисовки: loadOrders сразу вызывает notifyListeners.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) AppScope.of(context).loadOrders();
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final s = app.s;
    final orders = app.orders;

    Widget body;
    if (orders.isEmpty && app.ordersLoading) {
      body = const Center(child: CircularProgressIndicator());
    } else if (orders.isEmpty && app.ordersFailed) {
      body = Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(s.t('historyFailed'),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: app.loadOrders,
              icon: const Icon(Icons.refresh),
              label: Text(s.t('retry'), style: const TextStyle(fontSize: 18)),
            ),
          ],
        ),
      );
    } else if (orders.isEmpty) {
      body = Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.receipt_long, size: 72, color: Theme.of(context).disabledColor),
            const SizedBox(height: 12),
            Text(s.t('historyEmpty'), style: Theme.of(context).textTheme.titleLarge),
          ],
        ),
      );
    } else {
      body = RefreshIndicator(
        onRefresh: app.loadOrders,
        child: ListView.separated(
          padding: const EdgeInsets.all(12),
          itemCount: orders.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, i) => OrderCard(order: orders[i], s: s),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(toolbarHeight: 64, title: Text(s.t('history'))),
      body: body,
    );
  }
}

class OrderCard extends StatelessWidget {
  const OrderCard({super.key, required this.order, required this.s});

  final OrderRecord order;
  final S s;

  String _date(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(d.day)}.${two(d.month)}.${d.year}  ${two(d.hour)}:${two(d.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final (label, color, icon) = switch (order.status) {
      OrderStatus.ready => (s.t('statusReady'), cs.tertiary, Icons.hourglass_top),
      OrderStatus.pickedUp => (s.t('statusPickedUp'), Colors.green, Icons.check_circle),
      OrderStatus.cancelled => (s.t('statusCancelled'), cs.error, Icons.undo),
    };

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: color, size: 22),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(label,
                      style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 16)),
                ),
                Text(_date(order.createdAt), style: const TextStyle(fontSize: 14)),
              ],
            ),
            const SizedBox(height: 10),
            for (final it in order.items)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: [
                    Expanded(
                      child: Text('${it.name(s.lang)}  × ${it.qty}',
                          style: const TextStyle(fontSize: 16)),
                    ),
                    Text(s.money(it.price * it.qty), style: const TextStyle(fontSize: 16)),
                  ],
                ),
              ),
            const Divider(height: 20),
            Row(
              children: [
                Text(s.t('total'),
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
                const Spacer(),
                Text(s.money(order.total),
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
              ],
            ),
            // Код нужен только пока заказ не выдан.
            if (order.status == OrderStatus.ready) ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 10),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Column(
                  children: [
                    Text(s.t('orderCode'), style: const TextStyle(fontSize: 13)),
                    Text(order.code,
                        style: const TextStyle(
                            fontSize: 30, fontWeight: FontWeight.bold, letterSpacing: 4)),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
