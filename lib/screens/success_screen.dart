import 'package:flutter/material.dart';

import '../state/app_state.dart';
import 'catalog_screen.dart';

class SuccessScreen extends StatelessWidget {
  const SuccessScreen({super.key, required this.code});

  final String code;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final s = app.s;
    final cs = Theme.of(context).colorScheme;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.check_circle, size: 96, color: cs.primary),
                  const SizedBox(height: 12),
                  Text(s.t('orderPlaced'),
                      style: Theme.of(context)
                          .textTheme
                          .headlineMedium
                          ?.copyWith(fontWeight: FontWeight.bold)),
                  const SizedBox(height: 24),
                  Text(s.t('orderCode'),
                      style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 8),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 28, vertical: 14),
                    decoration: BoxDecoration(
                      color: cs.primaryContainer,
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Text(code,
                        style: TextStyle(
                            fontSize: 56,
                            letterSpacing: 8,
                            fontWeight: FontWeight.bold,
                            color: cs.onPrimaryContainer)),
                  ),
                  const SizedBox(height: 20),
                  Text(s.t('pickupHint'),
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 18)),
                  const SizedBox(height: 8),
                  Text('${s.t('balance')}: ${s.money(app.balance)}',
                      style: TextStyle(fontSize: 18, color: cs.outline)),
                  const SizedBox(height: 28),
                  SizedBox(
                    width: double.infinity,
                    height: 64,
                    child: FilledButton(
                      onPressed: () => Navigator.of(context).pushReplacement(
                        MaterialPageRoute(builder: (_) => const CatalogScreen()),
                      ),
                      child: Text(s.t('newOrder'),
                          style: const TextStyle(fontSize: 22)),
                    ),
                  ),
                  const SizedBox(height: 10),
                  SizedBox(
                    width: double.infinity,
                    height: 56,
                    child: OutlinedButton.icon(
                      onPressed: app.logout,
                      icon: const Icon(Icons.logout),
                      label: Text(s.t('logout'),
                          style: const TextStyle(fontSize: 18)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
