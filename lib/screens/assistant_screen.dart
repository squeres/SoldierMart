import 'package:flutter/material.dart';

import '../models/assistant.dart';
import '../state/app_state.dart';

/// Чат с помощником магазина. Помощник только советует и ищет товары:
/// заказ оформляет сам человек в корзине.
class AssistantScreen extends StatefulWidget {
  const AssistantScreen({super.key});

  @override
  State<AssistantScreen> createState() => _AssistantScreenState();
}

class _AssistantScreenState extends State<AssistantScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _focus = FocusNode();

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _send(AppState app, String text) async {
    if (text.trim().isEmpty || app.assistantBusy) return;
    _input.clear();
    final future = app.askAssistant(text);
    _toEnd();
    await future;
    if (mounted) _toEnd();
  }

  void _toEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _note(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text, style: const TextStyle(fontSize: 16))));
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final s = app.s;
    final cs = Theme.of(context).colorScheme;

    final last = app.chat.isNotEmpty && !app.chat.last.fromUser ? app.chat.last : null;
    final chips = last != null && last.suggestions.isNotEmpty
        ? last.suggestions
        : s.t('assistantStarters').split('|');

    return Scaffold(
      appBar: AppBar(toolbarHeight: 64, title: Text(s.t('assistant'))),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.all(12),
                children: [
                  _Bubble(text: s.t('assistantHello'), fromUser: false),
                  for (final m in app.chat) _message(context, app, m),
                  if (app.assistantBusy)
                    _Bubble(text: s.t('assistantTyping'), fromUser: false, faded: true),
                ],
              ),
            ),
            SizedBox(
              height: 52,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                children: [
                  for (final c in chips)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                      child: ActionChip(
                        label: Text(c, style: const TextStyle(fontSize: 16)),
                        onPressed: app.assistantBusy ? null : () => _send(app, c),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      focusNode: _focus,
                      maxLength: 300,
                      textInputAction: TextInputAction.send,
                      onChanged: (_) => app.touch(), // экранная клавиатура и ввод текста
                      onSubmitted: (v) {
                        _send(app, v);
                        _focus.requestFocus();
                      },
                      style: const TextStyle(fontSize: 18),
                      decoration: InputDecoration(
                        hintText: s.t('assistantHint'),
                        counterText: '',
                        isDense: true,
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    iconSize: 28,
                    tooltip: s.t('assistantSend'),
                    style: IconButton.styleFrom(
                      backgroundColor: cs.primary,
                      foregroundColor: cs.onPrimary,
                      minimumSize: const Size(52, 52),
                    ),
                    onPressed: app.assistantBusy ? null : () => _send(app, _input.text),
                    icon: const Icon(Icons.send),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _message(BuildContext context, AppState app, ChatMessage m) {
    if (m.fromUser) return _Bubble(text: m.text, fromUser: true);
    final s = app.s;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Bubble(text: m.text, fromUser: false),
        for (final p in m.products)
          _ProductTile(
            item: p,
            money: s.money,
            onAdd: () {
              final n = app.addAssistantItems([p]);
              _note(n > 0 ? s.t('assistantAdded') : s.t('assistantNothing'));
            },
          ),
        if (m.cart != null && m.cart!.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(0, 6, 0, 10),
            child: FilledButton.icon(
              onPressed: () {
                final n = app.addAssistantItems(m.cart!);
                _note(n > 0 ? s.t('assistantAdded') : s.t('assistantNothing'));
              },
              icon: const Icon(Icons.add_shopping_cart),
              label: Text(s.t('assistantAddAll'), style: const TextStyle(fontSize: 17)),
            ),
          ),
      ],
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.text, required this.fromUser, this.faded = false});

  final String text;
  final bool fromUser;
  final bool faded;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Align(
      alignment: fromUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        decoration: BoxDecoration(
          color: fromUser ? cs.primary : cs.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(
          text,
          style: TextStyle(
            fontSize: 17,
            color: fromUser ? cs.onPrimary : cs.onSurface.withValues(alpha: faded ? 0.6 : 1),
            fontStyle: faded ? FontStyle.italic : FontStyle.normal,
          ),
        ),
      ),
    );
  }
}

class _ProductTile extends StatelessWidget {
  const _ProductTile({required this.item, required this.money, required this.onAdd});

  final AssistantItem item;
  final String Function(int) money;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 3),
      child: ListTile(
        title: Text(item.qty > 1 ? '${item.name}  × ${item.qty}' : item.name,
            style: const TextStyle(fontSize: 17)),
        subtitle: Text(money(item.price * item.qty), style: const TextStyle(fontSize: 15)),
        trailing: IconButton(
          iconSize: 28,
          onPressed: onAdd,
          icon: Icon(Icons.add_shopping_cart, color: Theme.of(context).colorScheme.primary),
        ),
      ),
    );
  }
}
