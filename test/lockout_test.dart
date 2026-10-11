import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:soldiermart/models/assistant.dart';
import 'package:soldiermart/models/product.dart';
import 'package:soldiermart/services/api_client.dart';
import 'package:soldiermart/services/face_verifier.dart';
import 'package:soldiermart/state/app_state.dart';

import 'support/fake_backend.dart';

Future<AppState> _loggedIn(FakeBackend b) async {
  final app = AppState(backend: b);
  await app.checkCredentials('0', '0000');
  await app.verifyFace(Uint8List(1));
  await Future<void>.delayed(Duration.zero); // дать загрузиться каталогу
  return app;
}

void main() {
  test('неверный ПИН и блокировка: входа нет', () async {
    final b = FakeBackend();
    final app = AppState(backend: b);

    b.loginResult = const LoginResponse(LoginStatus.wrong, attemptsLeft: 2);
    var r = await app.checkCredentials('0', '1111');
    expect(r.status, LoginStatus.wrong);
    expect(r.attemptsLeft, 2);
    expect(app.hasPending, isFalse);

    b.loginResult = const LoginResponse(LoginStatus.locked);
    r = await app.checkCredentials('0', '0000');
    expect(r.status, LoginStatus.locked);
    expect(app.hasPending, isFalse);
    expect(app.loggedIn, isFalse);
  });

  test('ИИН+ПИН без лица не пускают в аккаунт', () async {
    final app = AppState(backend: FakeBackend());
    await app.checkCredentials('0', '0000');
    expect(app.hasPending, isTrue);
    expect(app.loggedIn, isFalse);
  });

  test('полный вход: баланс, избранное и каталог с сервера', () async {
    final app = await _loggedIn(FakeBackend());
    expect(app.loggedIn, isTrue);
    expect(app.hasPending, isFalse);
    expect(app.balance, 1000);
    expect(app.isFavorite(kWater), isTrue);
    expect(app.catalog.length, 1);
  });

  test('неудачная проверка лица: остаёмся без входа, попытки обновляются', () async {
    final b = FakeBackend();
    final app = AppState(backend: b);
    await app.checkCredentials('0', '0000');
    b.faceResult = const FaceResponse(FaceResult.noMatch, attemptsLeft: 2);
    final r = await app.verifyFace(Uint8List(1));
    expect(r, FaceResult.noMatch);
    expect(app.faceAttemptsLeft, 2);
    expect(app.loggedIn, isFalse);
    expect(app.hasPending, isTrue);
  });

  test('блокировка по лицу: сеанс сброшен, на экране входа сообщение', () async {
    final b = FakeBackend();
    final app = AppState(backend: b);
    await app.checkCredentials('0', '0000');
    b.faceResult = const FaceResponse(FaceResult.noMatch, locked: true);
    await app.verifyFace(Uint8List(1));
    expect(app.hasPending, isFalse);
    expect(app.loggedIn, isFalse);
    expect(app.loginNotice, 'accountLocked');
  });

  test('заказ: успех очищает корзину и обновляет баланс', () async {
    final app = await _loggedIn(FakeBackend());
    app.add(kWater);
    final r = await app.placeOrder();
    expect(r.ok, isTrue);
    expect(app.cartCount, 0);
    expect(app.balance, 800);
  });

  test('заказ: отказ сервера оставляет корзину', () async {
    final b = FakeBackend()
      ..orderResult = const OrderResponse(failure: OrderFailure.insufficientFunds);
    final app = await _loggedIn(b);
    app.add(kWater);
    final r = await app.placeOrder();
    expect(r.ok, isFalse);
    expect(app.cartCount, 1);
    expect(app.balance, 1000);
  });

  test('requestId стабилен при повторе и меняется после правки корзины', () async {
    final b = FakeBackend()..orderResult = const OrderResponse(failure: OrderFailure.network);
    final app = await _loggedIn(b);
    app.add(kWater);
    await app.placeOrder();
    await app.placeOrder();
    expect(b.requestIds[0], b.requestIds[1]);

    app.add(kWater);
    await app.placeOrder();
    expect(b.requestIds[2], isNot(b.requestIds[0]));
  });

  test('401 от сервера: выход и сообщение о завершённом сеансе', () async {
    final b = FakeBackend()
      ..orderResult = const OrderResponse(failure: OrderFailure.sessionExpired);
    final app = await _loggedIn(b);
    app.add(kWater);
    await app.placeOrder();
    expect(app.loggedIn, isFalse);
    expect(app.loginNotice, 'sessionExpired');
  });

  test('выход очищает данные и закрывает сеанс на сервере', () async {
    final b = FakeBackend();
    final app = await _loggedIn(b);
    app.add(kWater);
    app.logout();
    expect(app.loggedIn, isFalse);
    expect(app.cartCount, 0);
    expect(app.catalog, isEmpty);
    expect(b.logoutCalls, 1);
  });

  test('ошибка загрузки каталога помечается, а не роняет приложение', () async {
    final b = FakeBackend()..catalogError = ApiException(null);
    final app = await _loggedIn(b);
    expect(app.catalogFailed, isTrue);
  });

  test('история заказов загружается и очищается при выходе', () async {
    final b = FakeBackend()
      ..ordersResult = [
        OrderRecord(
          id: 'o1',
          code: '111222',
          total: 400,
          status: OrderStatus.ready,
          createdAt: DateTime(2026, 10, 7, 12, 30),
          items: const [OrderLineRecord(nameRu: 'Вода', nameKk: 'Су', price: 200, qty: 2)],
        ),
      ];
    final app = await _loggedIn(b);
    await app.loadOrders();
    expect(app.orders.length, 1);
    expect(app.orders.first.status, OrderStatus.ready);
    app.logout();
    expect(app.orders, isEmpty); // следующий человек не увидит чужие заказы
  });

  test('ошибка истории помечается, истёкший сеанс возвращает на вход', () async {
    final b = FakeBackend()..ordersError = ApiException(null);
    final app = await _loggedIn(b);
    await app.loadOrders();
    expect(app.ordersFailed, isTrue);
    expect(app.loggedIn, isTrue);

    b.ordersError = ApiException(401);
    await app.loadOrders();
    expect(app.loggedIn, isFalse);
    expect(app.loginNotice, 'sessionExpired');
  });

  test('заказ из ответа сервера разбирается, неизвестный статус не ломает разбор', () {
    final o = OrderRecord.fromJson({
      'id': 'x',
      'code': '123456',
      'total': 700,
      'status': 'picked_up',
      'createdAt': '2026-10-07T18:54:27.352Z',
      'items': [
        {'productId': 'f1', 'nameRu': 'Печенье', 'nameKk': 'Печенье', 'price': 350, 'qty': 2},
      ],
    });
    expect(o.status, OrderStatus.pickedUp);
    expect(o.items.single.qty, 2);
    expect(OrderRecord.fromJson({...{'id': 'y', 'code': '1', 'total': 1, 'createdAt': 'bad', 'items': []}, 'status': 'zzz'}).status,
        OrderStatus.ready);
  });

  test('помощник: вопрос уходит с языком, ответ попадает в чат, выход очищает переписку', () async {
    final b = FakeBackend()
      ..assistantResult = const AssistantReply(
        reply: 'Нашёл:',
        suggestions: ['Баланс'],
        products: [AssistantItem(id: 'f1', name: 'Вода', price: 200, qty: 1, stock: 5)],
      );
    final app = await _loggedIn(b);
    app.setLang('kk');
    await app.askAssistant('  су керек ');
    expect(b.assistantQuestions, ['kk:су керек']);
    expect(app.chat.length, 2);
    expect(app.chat.first.fromUser, isTrue);
    expect(app.chat.last.products.single.id, 'f1');
    expect(app.assistantBusy, isFalse);

    await app.askAssistant('   '); // пустой вопрос не отправляется
    expect(b.assistantQuestions.length, 1);

    app.logout();
    expect(app.chat, isEmpty); // следующий человек не увидит чужие вопросы
  });

  test('помощник: «добавить всё» кладёт в корзину не больше остатка и сбрасывает requestId', () async {
    final b = FakeBackend();
    final app = await _loggedIn(b); // в каталоге вода f1, остаток 5
    final added = app.addAssistantItems(const [
      AssistantItem(id: 'f1', name: '', price: 0, qty: 3, stock: 0),
      AssistantItem(id: 'нет-такого', name: '', price: 0, qty: 2, stock: 0),
    ]);
    expect(added, 3);
    expect(app.cartCount, 3);
    final again = app.addAssistantItems(const [AssistantItem(id: 'f1', name: '', price: 0, qty: 10, stock: 0)]);
    expect(again, 2, reason: 'всего не больше остатка 5');
    expect(app.cartCount, 5);
    expect(app.addAssistantItems(const [AssistantItem(id: 'f1', name: '', price: 0, qty: 1, stock: 0)]), 0);
  });

  test('помощник: ошибки не роняют чат; истёкший сеанс возвращает на вход', () async {
    final b = FakeBackend()..assistantError = ApiException(null);
    final app = await _loggedIn(b);
    await app.askAssistant('привет');
    expect(app.chat.last.text, app.s.t('assistantError'));
    expect(app.assistantBusy, isFalse);

    b.assistantError = ApiException(429);
    await app.askAssistant('ещё');
    expect(app.chat.last.text, app.s.t('assistantSlow'));

    b.assistantError = ApiException(401);
    await app.askAssistant('и ещё');
    expect(app.loggedIn, isFalse);
    expect(app.loginNotice, 'sessionExpired');
  });

  test('ответ помощника разбирается, готовый набор распознаётся', () {
    final r = AssistantReply.fromJson({
      'reply': 'Подобрал',
      'suggestions': ['Баланс'],
      'products': [
        {'id': 'f1', 'name': 'Печенье', 'price': 650, 'qty': 2, 'stock': 9},
      ],
      'cart': [
        {'productId': 'f1', 'qty': 2},
      ],
    });
    expect(r.products.single.qty, 2);
    expect(r.cart!.single.id, 'f1');
    expect(AssistantReply.fromJson({'reply': 'x', 'cart': null}).cart, isNull);
  });

}
