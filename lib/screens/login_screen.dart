import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../state/app_state.dart';
import '../utils/iin.dart';
import 'face_screen.dart';

/// Вход по ИИН и ПИН-коду с экранной цифровой клавиатурой (на терминале может
/// не быть физической клавиатуры). Дальше обязательна проверка лица.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  String _id = '';
  String _pin = '';
  bool _editingPin = false;
  String? _errorKey;
  int? _attemptsLeft;
  bool _busy = false;

  void _digit(String d) {
    AppScope.of(context).clearLoginNotice();
    setState(() {
      _errorKey = null;
      _attemptsLeft = null;
      if (_editingPin) {
        if (_pin.length < 4) _pin += d;
      } else {
        if (_id.length < 12) {
          _id += d;
          // ИИН набран полностью — сразу переходим к вводу ПИН-кода.
          if (_id.length == 12 && isValidIin(_id)) _editingPin = true;
        }
      }
    });
  }

  void _back() {
    AppScope.of(context).clearLoginNotice();
    setState(() {
      _errorKey = null;
      _attemptsLeft = null;
      if (_editingPin) {
        if (_pin.isNotEmpty) _pin = _pin.substring(0, _pin.length - 1);
      } else {
        if (_id.isNotEmpty) _id = _id.substring(0, _id.length - 1);
      }
    });
  }

  Future<void> _submit() async {
    if (_busy) return;
    final app = AppScope.of(context);
    if (!isValidIin(_id)) {
      setState(() {
        _errorKey = 'iinInvalid';
        _pin = '';
        _editingPin = false;
      });
      return;
    }

    setState(() => _busy = true);
    // Проверку ИИН/ПИН и подсчёт неверных попыток делает сервер.
    final r = await app.checkCredentials(_id, _pin);
    if (!mounted) return;
    setState(() => _busy = false);

    switch (r.status) {
      case LoginStatus.ok:
        // ИИН и ПИН верны, но вход ещё не выполнен: обязательна проверка лица.
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (_) => const FaceScreen()),
        );
      case LoginStatus.wrong:
        setState(() {
          _errorKey = 'wrongCreds';
          _attemptsLeft = r.attemptsLeft;
          _pin = '';
          // Остаёмся в поле ПИН: ИИН не менялся, нужно просто набрать ПИН заново.
          _editingPin = true;
        });
      case LoginStatus.locked:
        setState(() {
          _errorKey = 'accountLocked';
          _attemptsLeft = null;
          _pin = '';
          _editingPin = false;
        });
      case LoginStatus.networkError:
        // ПИН не стираем: после восстановления связи достаточно нажать «Войти».
        setState(() {
          _errorKey = 'networkError';
          _attemptsLeft = null;
        });
    }
  }

  /// Текст ошибки под полями ввода (или null, если ошибок нет).
  String? _errorText(AppState app) {
    final key = _errorKey ?? app.loginNotice;
    if (key == null) return null;
    final s = app.s;
    final left = _attemptsLeft;
    return left == null ? s.t(key) : '${s.t(key)} ${s.t('attemptsLeft')}: $left';
  }

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
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      SegmentedButton<String>(
                        segments: const [
                          ButtonSegment(value: 'ru', label: Text('RU')),
                          ButtonSegment(value: 'kk', label: Text('ҚАЗ')),
                        ],
                        selected: {app.lang},
                        onSelectionChanged: (v) => app.setLang(v.first),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Icon(Icons.shield, size: 64, color: cs.primary),
                  const SizedBox(height: 8),
                  Text('SoldierMart.kz',
                      style: Theme.of(context)
                          .textTheme
                          .headlineMedium
                          ?.copyWith(fontWeight: FontWeight.bold)),
                  Text(s.t('tagline'),
                      style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 20),
                  _Field(
                    label: s.t('iin'),
                    value: _id,
                    active: !_editingPin,
                    onTap: () => setState(() => _editingPin = false),
                  ),
                  const SizedBox(height: 10),
                  _Field(
                    label: s.t('pin'),
                    value: '•' * _pin.length,
                    active: _editingPin,
                    onTap: () => setState(() => _editingPin = true),
                  ),
                  SizedBox(
                    height: 56,
                    child: Center(
                      child: _errorText(app) != null
                          ? Text(_errorText(app)!,
                              textAlign: TextAlign.center,
                              style: TextStyle(color: cs.error, fontSize: 16))
                          : Text(s.t('demoHint'),
                              style: TextStyle(color: cs.outline)),
                    ),
                  ),
                  _Keypad(onDigit: _digit, onBack: _back),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    height: 64,
                    child: FilledButton(
                      onPressed: _id.length == 12 && _pin.length == 4 && !_busy
                          ? _submit
                          : null,
                      child: _busy
                          ? const SizedBox(
                              width: 26,
                              height: 26,
                              child: CircularProgressIndicator(strokeWidth: 3),
                            )
                          : Text(s.t('login'),
                              style: const TextStyle(fontSize: 22)),
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

class _Field extends StatelessWidget {
  const _Field({
    required this.label,
    required this.value,
    required this.active,
    required this.onTap,
  });

  final String label;
  final String value;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
              color: active ? cs.primary : cs.outline,
              width: active ? 3 : 1),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(color: cs.outline, fontSize: 13)),
            const SizedBox(height: 2),
            Text(value.isEmpty ? ' ' : value,
                style: const TextStyle(
                    fontSize: 28, letterSpacing: 4, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}

class _Keypad extends StatelessWidget {
  const _Keypad({required this.onDigit, required this.onBack});

  final void Function(String) onDigit;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    Widget key(String label, VoidCallback onTap, {IconData? icon}) {
      return Padding(
        padding: const EdgeInsets.all(4),
        child: SizedBox(
          height: 64,
          child: FilledButton.tonal(
            onPressed: onTap,
            child: icon != null
                ? Icon(icon, size: 28)
                : Text(label, style: const TextStyle(fontSize: 26)),
          ),
        ),
      );
    }

    final rows = [
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'],
    ];
    return Column(
      children: [
        for (final r in rows)
          Row(children: [
            for (final d in r) Expanded(child: key(d, () => onDigit(d))),
          ]),
        Row(children: [
          const Expanded(child: SizedBox()),
          Expanded(child: key('0', () => onDigit('0'))),
          Expanded(child: key('', onBack, icon: Icons.backspace_outlined)),
        ]),
      ],
    );
  }
}
