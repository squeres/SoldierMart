import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soldiermart/screens/login_screen.dart';
import 'package:soldiermart/state/app_state.dart';
import 'package:soldiermart/theme/app_theme.dart';

import 'support/fake_backend.dart';

const _iin = '030515501234'; // вымышленный, проходит проверку контрольной цифры

const _digits = {
  '0': LogicalKeyboardKey.digit0,
  '1': LogicalKeyboardKey.digit1,
  '2': LogicalKeyboardKey.digit2,
  '3': LogicalKeyboardKey.digit3,
  '4': LogicalKeyboardKey.digit4,
  '5': LogicalKeyboardKey.digit5,
  '6': LogicalKeyboardKey.digit6,
  '7': LogicalKeyboardKey.digit7,
  '8': LogicalKeyboardKey.digit8,
  '9': LogicalKeyboardKey.digit9,
};

Future<(AppState, FakeBackend)> _open(
  WidgetTester t, {
  Duration saverAfter = const Duration(minutes: 30),
}) async {
  final backend = FakeBackend();
  final app = AppState(backend: backend);
  addTearDown(app.dispose);
  t.view.physicalSize = const Size(900, 1400);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(AppScope(
    state: app,
    child: MaterialApp(theme: buildTheme(), home: LoginScreen(saverAfter: saverAfter)),
  ));
  await t.pump();
  return (app, backend);
}

Future<void> _type(WidgetTester t, String digits) async {
  for (final d in digits.split('')) {
    await t.sendKeyEvent(_digits[d]!);
  }
  await t.pump();
}

/// Текст в поле по подписи (значение лежит в соседнем Text).
String _field(WidgetTester t, String label) {
  final texts = t.widgetList<Text>(find.byType(Text)).map((x) => x.data ?? '').toList();
  return texts[texts.indexOf(label) + 1];
}

void main() {
  testWidgets('цифры с клавиатуры попадают в ИИН, затем сами в ПИН (он скрыт точками)', (t) async {
    await _open(t);
    await _type(t, _iin);
    expect(_field(t, 'ИИН (12 цифр)'), _iin);
    await _type(t, '12');
    expect(_field(t, 'ПИН-код'), '••');
    expect(_field(t, 'ИИН (12 цифр)'), _iin, reason: 'ИИН не изменился');
  });

  testWidgets('Backspace стирает последнюю цифру активного поля, Delete стирает поле целиком', (t) async {
    await _open(t);
    await _type(t, '0305');
    await t.sendKeyEvent(LogicalKeyboardKey.backspace);
    await t.pump();
    expect(_field(t, 'ИИН (12 цифр)').trim(), '030');
    await t.sendKeyEvent(LogicalKeyboardKey.delete);
    await t.pump();
    expect(_field(t, 'ИИН (12 цифр)').trim(), '');
  });

  testWidgets('Tab переключает поле, номерной блок и Enter работают, лишние клавиши игнорируются', (t) async {
    final (app, backend) = await _open(t);
    await t.sendKeyEvent(LogicalKeyboardKey.keyA); // буквы не вводятся
    await t.sendKeyEvent(LogicalKeyboardKey.numpad0);
    await t.sendKeyEvent(LogicalKeyboardKey.numpad3);
    await t.pump();
    expect(_field(t, 'ИИН (12 цифр)').trim(), '03');

    await t.sendKeyEvent(LogicalKeyboardKey.tab);
    await _type(t, '99');
    expect(_field(t, 'ПИН-код'), '••');
    expect(_field(t, 'ИИН (12 цифр)').trim(), '03');
    await t.sendKeyEvent(LogicalKeyboardKey.tab); // обратно в ИИН
    await _type(t, '0515501234');
    expect(_field(t, 'ИИН (12 цифр)'), _iin);

    // Enter без полного ПИН ничего не отправляет
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(app.hasPending, isFalse);

    // ИИН набран полностью, фокус сам ушёл в ПИН: дописываем его
    await _type(t, '34');
    expect(_field(t, 'ПИН-код'), '••••');
    expect(backend.loginCalls, 0, reason: 'без Enter вход не отправляется');
  });

  testWidgets('Enter при полном ИИН и ПИН отправляет вход на сервер', (t) async {
    final (app, backend) = await _open(t);
    await _type(t, _iin);
    await _type(t, '1234');
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));
    expect(backend.loginCalls, 1);
    expect(app.hasPending, isTrue, reason: 'ИИН и ПИН приняты, дальше проверка лица');
    app.cancelPending(); // останавливаем таймер бездействия, он не должен жить после теста
  });

  testWidgets('нажатие экранной кнопки мышью не крадёт фокус: следующий Enter всё равно входит', (t) async {
    final (app, backend) = await _open(t);
    await t.tap(find.text('0'));
    await t.pump();
    await _type(t, '305155012');
    await t.tap(find.text('3'));
    await t.tap(find.text('4'));
    await t.pump();
    expect(_field(t, 'ИИН (12 цифр)'), _iin);
    await _type(t, '123');
    await t.tap(find.text('4'));
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.enter); // не должен повторить цифру «4»
    await t.pump();
    await t.pump(const Duration(milliseconds: 50));
    expect(backend.loginCalls, 1);
    expect(app.hasPending, isTrue);
    app.cancelPending();
  });

  // ---------- заставка ----------

  final saver = find.byKey(const ValueKey('screensaver'));

  testWidgets('заставка появляется после бездействия и стирает набранное', (t) async {
    await _open(t, saverAfter: const Duration(seconds: 5));
    await _type(t, '0305');
    expect(saver, findsNothing);

    await t.pump(const Duration(seconds: 4));
    expect(saver, findsNothing, reason: 'ещё рано');
    await t.pump(const Duration(seconds: 2));
    await t.pump(const Duration(milliseconds: 700)); // плавное появление
    expect(saver, findsOneWidget);

    // касание закрывает заставку, цифры стёрты и случайно не нажаты
    await t.tapAt(const Offset(450, 400));
    await t.pump();
    expect(saver, findsNothing);
    expect(_field(t, 'ИИН (12 цифр)').trim(), '');
    expect(_field(t, 'ПИН-код').trim(), '');
  });

  testWidgets('любая активность откладывает заставку', (t) async {
    await _open(t, saverAfter: const Duration(seconds: 5));
    for (var i = 0; i < 4; i++) {
      await t.pump(const Duration(seconds: 3));
      await t.sendKeyEvent(LogicalKeyboardKey.digit1); // нажатие клавиши
    }
    expect(saver, findsNothing, reason: '12 секунд с нажатиями каждые 3 не бездействие');
    await t.pump(const Duration(seconds: 3));
    await t.tap(find.text('5')); // касание экранной клавиши
    await t.pump(const Duration(seconds: 4));
    expect(saver, findsNothing);
    await t.pump(const Duration(seconds: 2));
    await t.pump(const Duration(milliseconds: 700));
    expect(saver, findsOneWidget);
  });

  testWidgets('клавиша закрывает заставку и сама не вводится', (t) async {
    await _open(t, saverAfter: const Duration(seconds: 2));
    await t.pump(const Duration(seconds: 3));
    await t.pump(const Duration(milliseconds: 700));
    expect(saver, findsOneWidget);

    await t.sendKeyEvent(LogicalKeyboardKey.digit7);
    await t.pump();
    expect(saver, findsNothing);
    expect(_field(t, 'ИИН (12 цифр)').trim(), '', reason: 'цифра ушла на закрытие заставки');

    await t.sendKeyEvent(LogicalKeyboardKey.digit7); // теперь вводится
    await t.pump();
    expect(_field(t, 'ИИН (12 цифр)').trim(), '7');
  });

  testWidgets('заставка не появляется, пока идёт проверка на сервере', (t) async {
    final (app, backend) = await _open(t, saverAfter: const Duration(seconds: 2));
    backend.loginDelay = const Duration(seconds: 5);
    await _type(t, _iin);
    await _type(t, '1234');
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump(const Duration(seconds: 3));
    expect(saver, findsNothing, reason: 'человек ждёт ответа, заставка не нужна');
    await t.pump(const Duration(seconds: 3));
    expect(app.hasPending, isTrue);
    app.cancelPending();
  });
}
