import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'screens/login_screen.dart';
import 'state/app_state.dart';
import 'theme/app_theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // Режим киоска: скрываем системные панели, экран не гаснет в приложении.
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  runApp(const SoldierMartApp());
}

class SoldierMartApp extends StatefulWidget {
  const SoldierMartApp({super.key});

  @override
  State<SoldierMartApp> createState() => _SoldierMartAppState();
}

class _SoldierMartAppState extends State<SoldierMartApp> {
  final AppState _state = AppState();
  final GlobalKey<NavigatorState> _nav = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    // Любой выход (кнопка «Выйти» или автовыход по бездействию)
    // возвращает терминал на экран входа и очищает стек экранов.
    _state.addListener(_handleLogout);
    // Печать на клавиатуре тоже считается активностью (иначе набор вопроса помощнику
    // дольше 90 секунд выбрасывал бы человека из аккаунта).
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  bool _onKey(KeyEvent event) {
    _state.touch();
    return false; // событие не поглощаем
  }

  bool _wasActive = false;

  void _handleLogout() {
    // «Активен» — человек вошёл или находится на шаге проверки лица.
    final active = _state.loggedIn || _state.hasPending;
    if (_wasActive && !active) {
      _nav.currentState?.pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const LoginScreen()),
        (_) => false,
      );
    }
    _wasActive = active;
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _state.removeListener(_handleLogout);
    _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: _state,
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => _state.touch(),
        onPointerMove: (_) => _state.touch(), // прокрутка пальцем
        onPointerSignal: (_) => _state.touch(), // колесо мыши
        child: MaterialApp(
          title: 'SoldierMart.kz',
          debugShowCheckedModeBanner: false,
          navigatorKey: _nav,
          theme: buildTheme(),
          home: const LoginScreen(),
        ),
      ),
    );
  }
}
