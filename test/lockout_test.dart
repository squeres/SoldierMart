import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soldiermart/models/product.dart';
import 'package:soldiermart/services/api_client.dart';
import 'package:soldiermart/services/face_verifier.dart';
import 'package:soldiermart/state/app_state.dart';

const _water = Product(
  id: 'f1',
  nameRu: 'Вода',
  nameKk: 'Су',
  category: Category.food,
  price: 200,
  icon: Icons.water_drop,
  stock: 5,
);

/// Подмена сервера: ответы задаются в тесте.
class FakeBackend implements Backend {
  LoginResponse loginResult = const LoginResponse(LoginStatus.ok, pendingToken: 'p');
  FaceResponse faceResult = const FaceResponse(
    FaceResult.match,
    soldier: Soldier(name: 'Тест', unit: 'В/Ч 1'),
    balance: 1000,
    favorites: {'f1'},
  );
  OrderResponse orderResult = const OrderResponse(code: '123456', balance: 800);
  Object? catalogError;
  final requestIds = <String>[];
  var logoutCalls = 0;

  @override
  Future<LoginResponse> login(String iin, String pin) async => loginResult;

  @override
  Future<FaceResponse> verifyFace(String t, Uint8List image) async => faceResult;

  @override
  Future<List<Product>> catalog() async {
    if (catalogError != null) throw catalogError!;
    return [_water];
  }

  @override
  Future<void> setFavorite(String id, bool v) async {}

  @override
  Future<OrderResponse> placeOrder(List<CartLine> lines, String requestId) async {
    requestIds.add(requestId);
    return orderResult;
  }

  List<OrderRecord> ordersResult = const [];
  Object? ordersError;

  @override
  Future<List<OrderRecord>> orders() async {
    if (ordersError != null) throw ordersError!;
    return ordersResult;
  }

  @override
  Future<void> logout() async => logoutCalls++;
}

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
    expect(app.isFavorite(_water), isTrue);
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
    app.add(_water);
    final r = await app.placeOrder();
    expect(r.ok, isTrue);
    expect(app.cartCount, 0);
    expect(app.balance, 800);
  });

  test('заказ: отказ сервера оставляет корзину', () async {
    final b = FakeBackend()
      ..orderResult = const OrderResponse(failure: OrderFailure.insufficientFunds);
    final app = await _loggedIn(b);
    app.add(_water);
    final r = await app.placeOrder();
    expect(r.ok, isFalse);
    expect(app.cartCount, 1);
    expect(app.balance, 1000);
  });

  test('requestId стабилен при повторе и меняется после правки корзины', () async {
    final b = FakeBackend()..orderResult = const OrderResponse(failure: OrderFailure.network);
    final app = await _loggedIn(b);
    app.add(_water);
    await app.placeOrder();
    await app.placeOrder();
    expect(b.requestIds[0], b.requestIds[1]);

    app.add(_water);
    await app.placeOrder();
    expect(b.requestIds[2], isNot(b.requestIds[0]));
  });

  test('401 от сервера: выход и сообщение о завершённом сеансе', () async {
    final b = FakeBackend()
      ..orderResult = const OrderResponse(failure: OrderFailure.sessionExpired);
    final app = await _loggedIn(b);
    app.add(_water);
    await app.placeOrder();
    expect(app.loggedIn, isFalse);
    expect(app.loginNotice, 'sessionExpired');
  });

  test('выход очищает данные и закрывает сеанс на сервере', () async {
    final b = FakeBackend();
    final app = await _loggedIn(b);
    app.add(_water);
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
}
