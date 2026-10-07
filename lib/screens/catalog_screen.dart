import 'package:flutter/material.dart';

import '../models/product.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import 'cart_screen.dart';
import 'orders_screen.dart';

class CatalogScreen extends StatelessWidget {
  const CatalogScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final s = app.s;
    final soldier = app.soldier;
    final products = app.visibleProducts;

    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 72,
        titleSpacing: 16,
        title: Row(
          children: [
            // Логотип слева от аккаунта (фон вырезан, PNG с прозрачностью).
            Image.asset(
              'assets/images/logo.png',
              height: 52,
              filterQuality: FilterQuality.high,
              semanticLabel: 'SoldierMart',
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(soldier?.name ?? '',
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.bold)),
                  Text('${s.t('balance')}: ${s.money(app.balance)}',
                      style: const TextStyle(fontSize: 16)),
                ],
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            iconSize: 30,
            tooltip: s.t('history'),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const OrdersScreen()),
            ),
            icon: const Icon(Icons.receipt_long),
          ),
          IconButton(
            iconSize: 30,
            tooltip: s.t('cart'),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const CartScreen()),
            ),
            icon: Badge(
              isLabelVisible: app.cartCount > 0,
              backgroundColor: Theme.of(context).colorScheme.tertiary,
              textColor: Theme.of(context).colorScheme.onTertiary,
              label: Text('${app.cartCount}'),
              child: const Icon(Icons.shopping_cart),
            ),
          ),
          IconButton(
            iconSize: 30,
            tooltip: s.t('logout'),
            onPressed: app.logout,
            icon: const Icon(Icons.logout),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
            child: TextField(
              onChanged: app.setQuery,
              style: const TextStyle(fontSize: 18),
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: s.t('search'),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                isDense: true,
              ),
            ),
          ),
          SizedBox(
            height: 60,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              children: [
                _Chip(
                    label: '${s.t('favorites')} (${app.favoritesCount})',
                    icon: app.favoritesOnly
                        ? Icons.favorite
                        : Icons.favorite_border,
                    selected: app.favoritesOnly,
                    onTap: () => app.setFavoritesOnly(!app.favoritesOnly)),
                _Chip(
                    label: s.t('all'),
                    selected: app.filter == null,
                    onTap: () => app.setFilter(null)),
                for (final c in Category.values)
                  _Chip(
                      label: s.category(c),
                      selected: app.filter == c,
                      onTap: () => app.setFilter(c)),
              ],
            ),
          ),
          Expanded(
            child: app.catalog.isEmpty && app.catalogLoading
                ? const Center(child: CircularProgressIndicator())
                : app.catalog.isEmpty && app.catalogFailed
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(s.t('catalogFailed'),
                            textAlign: TextAlign.center,
                            style: Theme.of(context).textTheme.titleLarge),
                        const SizedBox(height: 16),
                        FilledButton.icon(
                          onPressed: app.loadCatalog,
                          icon: const Icon(Icons.refresh),
                          label: Text(s.t('retry'),
                              style: const TextStyle(fontSize: 18)),
                        ),
                      ],
                    ),
                  )
                : products.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                          app.favoritesOnly && app.favoritesCount == 0
                              ? s.t('noFavorites')
                              : s.t('noResults'),
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.titleLarge),
                    ),
                  )
                : GridView.builder(
                    padding: const EdgeInsets.all(12),
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 240,
                      mainAxisExtent: 250,
                      crossAxisSpacing: 12,
                      mainAxisSpacing: 12,
                    ),
                    itemCount: products.length,
                    itemBuilder: (_, i) => _ProductCard(product: products[i]),
                  ),
          ),
        ],
      ),
      bottomNavigationBar: app.cartCount == 0
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: SizedBox(
                  height: 60,
                  child: FilledButton.icon(
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const CartScreen()),
                    ),
                    icon: const Icon(Icons.shopping_cart_checkout),
                    label: Text(
                      '${s.t('cart')} · ${app.cartCount} ${s.t('pcs')} · ${s.money(app.cartTotal)}',
                      style: const TextStyle(fontSize: 20),
                    ),
                  ),
                ),
              ),
            ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    required this.selected,
    required this.onTap,
    this.icon,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final fg = selected ? cs.onPrimary : cs.onSurface;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
      child: ChoiceChip(
        avatar: icon == null ? null : Icon(icon, size: 20, color: fg),
        label: Text(label, style: TextStyle(fontSize: 17, color: fg)),
        selectedColor: cs.primary,
        backgroundColor: cs.surfaceContainerHighest,
        checkmarkColor: cs.onPrimary,
        side: BorderSide(color: cs.outline),
        selected: selected,
        onSelected: (_) => onTap(),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      ),
    );
  }
}

class _ProductCard extends StatelessWidget {
  const _ProductCard({required this.product});

  final Product product;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final s = app.s;
    final cs = Theme.of(context).colorScheme;
    final qty = app.qtyOf(product);
    final canAdd = qty < app.stockOf(product);
    final isFav = app.isFavorite(product);

    return Card(
      clipBehavior: Clip.antiAlias,
      elevation: 0,
      color: cs.surfaceContainerHighest,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: cs.outline.withAlpha(110)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Stack(
                children: [
                  Container(
                    width: double.infinity,
                    height: double.infinity,
                    decoration: BoxDecoration(
                      color: cs.primaryContainer,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(product.icon,
                        size: 52, color: cs.onPrimaryContainer),
                  ),
                  Positioned(
                    top: 4,
                    right: 4,
                    child: IconButton(
                      iconSize: 26,
                      tooltip: isFav ? s.t('removeFav') : s.t('addFav'),
                      onPressed: () => app.toggleFavorite(product),
                      // Тёмная подложка, чтобы сердечко читалось на плитке.
                      style: IconButton.styleFrom(
                        backgroundColor: Brand.night.withAlpha(150),
                      ),
                      icon: Icon(
                        isFav ? Icons.favorite : Icons.favorite_border,
                        color: isFav ? Brand.heart : cs.tertiary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text(
              product.name(app.lang),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 2),
            Text(s.money(product.price),
                style: TextStyle(
                    fontSize: 18, fontWeight: FontWeight.bold, color: cs.primary)),
            const SizedBox(height: 6),
            qty == 0
                ? SizedBox(
                    width: double.infinity,
                    height: 44,
                    child: FilledButton(
                      onPressed: canAdd ? () => app.add(product) : null,
                      child: Text(s.t('add'), style: const TextStyle(fontSize: 16)),
                    ),
                  )
                : Row(
                    children: [
                      _RoundBtn(icon: Icons.remove, onTap: () => app.remove(product)),
                      Expanded(
                        child: Center(
                          child: Text('$qty',
                              style: const TextStyle(
                                  fontSize: 22, fontWeight: FontWeight.bold)),
                        ),
                      ),
                      _RoundBtn(
                          icon: Icons.add,
                          onTap: canAdd ? () => app.add(product) : null),
                    ],
                  ),
          ],
        ),
      ),
    );
  }
}

class _RoundBtn extends StatelessWidget {
  const _RoundBtn({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 48,
      height: 44,
      child: FilledButton.tonal(
        onPressed: onTap,
        style: FilledButton.styleFrom(padding: EdgeInsets.zero),
        child: Icon(icon),
      ),
    );
  }
}
