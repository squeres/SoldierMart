import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/api_client.dart';
import '../state/app_state.dart';
import '../utils/iin.dart';
import 'face_screen.dart';

/// Время до заставки на экране входа. Меняется при сборке для конкретного терминала:
/// `--dart-define=SAVER_SECONDS=120`. По умолчанию одна минута.
const Duration _defaultSaverAfter = Duration(seconds: int.fromEnvironment('SAVER_SECONDS', defaultValue: 60));

/// Вход по ИИН и ПИН-коду с экранной цифровой клавиатурой (на терминале может
/// не быть физической клавиатуры). Если она есть, работает и ввод с неё: цифры,
/// Backspace, Enter, Tab. Дальше обязательна проверка лица.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, this.saverAfter = _defaultSaverAfter});

  /// Через сколько без касаний на экране входа появляется заставка.
  final Duration saverAfter;

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

  // ---------- заставка ----------
  // Если на экране входа долго никого нет, показываем плакат магазина.
  // Введённые ИИН и ПИН при этом стираются: чужие цифры не должны висеть на экране.
  Timer? _saverTimer;
  bool _saverOn = false;

  @override
  void initState() {
    super.initState();
    _arm();
  }

  @override
  void dispose() {
    _saverTimer?.cancel();
    super.dispose();
  }

  /// Перезапускает отсчёт до заставки (на время запроса к серверу заставки не будет).
  void _arm() {
    _saverTimer?.cancel();
    if (_busy) return;
    _saverTimer = Timer(widget.saverAfter, _showSaver);
  }

  void _showSaver() {
    if (!mounted || _busy) return;
    AppScope.of(context).clearLoginNotice();
    setState(() {
      _saverOn = true;
      _id = '';
      _pin = '';
      _editingPin = false;
      _errorKey = null;
      _attemptsLeft = null;
    });
  }

  /// Касание или клавиша закрывает заставку. Это нажатие дальше не идёт:
  /// человек увидит чистый экран входа, а не случайно набранную цифру.
  void _wake() {
    if (_saverOn) setState(() => _saverOn = false);
    _arm();
  }

  /// Любая активность при открытом экране входа откладывает заставку.
  void _activity() {
    if (!_saverOn) _arm();
  }

  bool get _canSubmit => _id.length == 12 && _pin.length == 4 && !_busy;

  /// Цифра с физической клавиатуры: из символа клавиши, а если его нет, по самой клавише.
  static String? _digitOf(KeyEvent e) {
    final ch = e.character;
    if (ch != null &&
        ch.length == 1 &&
        ch.codeUnitAt(0) >= 48 &&
        ch.codeUnitAt(0) <= 57) {
      return ch;
    }
    const keys = [
      [LogicalKeyboardKey.digit0, LogicalKeyboardKey.numpad0],
      [LogicalKeyboardKey.digit1, LogicalKeyboardKey.numpad1],
      [LogicalKeyboardKey.digit2, LogicalKeyboardKey.numpad2],
      [LogicalKeyboardKey.digit3, LogicalKeyboardKey.numpad3],
      [LogicalKeyboardKey.digit4, LogicalKeyboardKey.numpad4],
      [LogicalKeyboardKey.digit5, LogicalKeyboardKey.numpad5],
      [LogicalKeyboardKey.digit6, LogicalKeyboardKey.numpad6],
      [LogicalKeyboardKey.digit7, LogicalKeyboardKey.numpad7],
      [LogicalKeyboardKey.digit8, LogicalKeyboardKey.numpad8],
      [LogicalKeyboardKey.digit9, LogicalKeyboardKey.numpad9],
    ];
    for (var d = 0; d < keys.length; d++) {
      if (keys[d].contains(e.logicalKey)) return '$d';
    }
    return null;
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (_saverOn) {
      if (e is KeyDownEvent) _wake();
      return KeyEventResult.handled;
    }
    _activity();
    if (e is KeyUpEvent) return KeyEventResult.ignored;
    final kb = HardwareKeyboard.instance;
    // Сочетания с Ctrl/Alt/Win (обновить страницу, закрыть вкладку) не перехватываем.
    if (kb.isControlPressed || kb.isAltPressed || kb.isMetaPressed) {
      return KeyEventResult.ignored;
    }
    final key = e.logicalKey;

    // Backspace можно удерживать, остальное только по нажатию.
    if (key == LogicalKeyboardKey.backspace) {
      if (!_busy) _back();
      return KeyEventResult.handled;
    }
    if (e is! KeyDownEvent) return KeyEventResult.ignored;

    final digit = _digitOf(e);
    if (digit != null) {
      if (!_busy) _digit(digit);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      if (_canSubmit) _submit();
      return KeyEventResult.handled;
    }
    // Tab и стрелки переключают поле: ИИН <-> ПИН.
    if (key == LogicalKeyboardKey.tab ||
        key == LogicalKeyboardKey.arrowUp ||
        key == LogicalKeyboardKey.arrowDown) {
      setState(() => _editingPin = !_editingPin);
      return KeyEventResult.handled;
    }
    // Delete и Escape стирают текущее поле целиком.
    if (key == LogicalKeyboardKey.delete || key == LogicalKeyboardKey.escape) {
      AppScope.of(context).clearLoginNotice();
      setState(() {
        _errorKey = null;
        _attemptsLeft = null;
        if (_editingPin) {
          _pin = '';
        } else {
          _id = '';
        }
      });
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

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
    _saverTimer?.cancel();
    // Проверку ИИН/ПИН и подсчёт неверных попыток делает сервер.
    final r = await app.checkCredentials(_id, _pin);
    if (!mounted) return;
    setState(() => _busy = false);
    _arm();

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
    return left == null
        ? s.t(key)
        : '${s.t(key)} ${s.t('attemptsLeft')}: $left';
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final s = app.s;
    final cs = Theme.of(context).colorScheme;

    return Scaffold(
      body: Focus(
        autofocus: true,
        onKeyEvent: _onKey,
        // Экранные кнопки не берут фокус: иначе после нажатия на цифру мышью Enter
        // повторил бы эту цифру вместо входа.
        child: Stack(
          children: [
            Listener(
              behavior: HitTestBehavior.translucent,
              onPointerDown: (_) => _activity(),
              onPointerMove: (_) => _activity(),
              onPointerSignal: (_) => _activity(),
              child: ExcludeFocus(
                child: SafeArea(
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
                                    ButtonSegment(
                                        value: 'ru', label: Text('RU')),
                                    ButtonSegment(
                                        value: 'kk', label: Text('ҚАЗ')),
                                  ],
                                  selected: {app.lang},
                                  onSelectionChanged: (v) =>
                                      app.setLang(v.first),
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
                              height: 80,
                              child: Center(
                                child: _errorText(app) != null
                                    ? Text(_errorText(app)!,
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                            color: cs.error, fontSize: 16))
                                    : Column(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Text(s.t('demoHint'),
                                              style:
                                                  TextStyle(color: cs.outline)),
                                          const SizedBox(height: 2),
                                          Text(s.t('keyboardHint'),
                                              textAlign: TextAlign.center,
                                              style: TextStyle(
                                                  color: cs.outline,
                                                  fontSize: 12)),
                                        ],
                                      ),
                              ),
                            ),
                            _Keypad(onDigit: _digit, onBack: _back),
                            const SizedBox(height: 12),
                            SizedBox(
                              width: double.infinity,
                              height: 64,
                              child: FilledButton(
                                onPressed: _canSubmit ? _submit : null,
                                child: _busy
                                    ? const SizedBox(
                                        width: 26,
                                        height: 26,
                                        child: CircularProgressIndicator(
                                            strokeWidth: 3),
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
              ),
            ),
            if (_saverOn) Positioned.fill(child: _Screensaver(onWake: _wake)),
          ],
        ),
      ),
    );
  }
}

/// Плакат на весь экран. Закрывается любым касанием.
class _Screensaver extends StatelessWidget {
  const _Screensaver({required this.onWake});

  final VoidCallback onWake;

  /// Фон плаката: по бокам, если экран шире картинки.
  static const _bg = Color(0xFFF5F7FC);

  @override
  Widget build(BuildContext context) {
    return Listener(
      key: const ValueKey('screensaver'),
      behavior: HitTestBehavior.opaque,
      onPointerDown: (_) => onWake(),
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: const Duration(milliseconds: 600),
        builder: (_, v, child) => Opacity(opacity: v, child: child),
        child: Semantics(
          label: 'SoldierMart.kz',
          child: ColoredBox(
            color: _bg,
            child: Image.asset(
              'assets/images/screensaver.jpg',
              fit: BoxFit.contain,
              alignment: Alignment.center,
              filterQuality: FilterQuality.high,
              // Если картинка не загрузилась, всё равно просим нажать.
              errorBuilder: (_, __, ___) => const Center(
                child: Text('SoldierMart.kz',
                    style:
                        TextStyle(fontSize: 32, fontWeight: FontWeight.w800)),
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
              color: active ? cs.primary : cs.outline, width: active ? 3 : 1),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(color: cs.outline, fontSize: 13)),
            const SizedBox(height: 2),
            Text(value.isEmpty ? ' ' : value,
                style: const TextStyle(
                    fontSize: 28,
                    letterSpacing: 4,
                    fontWeight: FontWeight.w600)),
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
