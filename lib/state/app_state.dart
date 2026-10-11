import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../models/assistant.dart';
import '../models/product.dart';
import '../services/api_client.dart';
import '../services/face_verifier.dart';

/// Состояние приложения. Данные (каталог, баланс, избранное, заказы, блокировки)
/// живут на сервере; здесь только то, что нужно для показа на экране.
class AppState extends ChangeNotifier {
  AppState({
    this.idleTimeout = const Duration(seconds: 90),
    Backend? backend,
  }) : _api = backend ?? ApiClient();

  final Backend _api;

  /// Через это время без касаний терминал сам завершает сеанс —
  /// следующий военнослужащий не увидит чужой аккаунт.
  final Duration idleTimeout;
  Timer? _idle;

  String lang = 'ru';
  S get s => S(lang);

  // ---------- вход: ИИН → ПИН → лицо ----------

  /// Токен шага «лицо». ИИН и ПИН пройдены, но это ещё не вход.
  String? _pendingToken;
  bool get hasPending => _pendingToken != null;

  /// Сервер сообщил, что проверка лица в демо-режиме (защиты не даёт).
  bool faceDemo = false;

  /// Сколько попыток проверки лица осталось до блокировки (по данным сервера).
  int faceAttemptsLeft = 3;

  /// Сообщение для экрана входа (например, аккаунт заблокирован).
  String? loginNotice;

  Soldier? soldier;
  bool get loggedIn => soldier != null;

  int _balance = 0;
  int get balance => _balance;

  void clearLoginNotice() {
    if (loginNotice == null) return;
    loginNotice = null;
    notifyListeners();
  }

  /// Шаг 1–2: ИИН и ПИН. Проверку и подсчёт неверных попыток делает сервер.
  /// При успехе человек ещё НЕ вошёл: остаётся обязательная проверка лица.
  Future<LoginResponse> checkCredentials(String iin, String pin) async {
    final r = await _api.login(iin.trim(), pin);
    if (r.status == LoginStatus.ok) {
      _pendingToken = r.pendingToken;
      faceDemo = r.faceDemo;
      faceAttemptsLeft = r.faceAttemptsLeft ?? 3;
      loginNotice = null;
      touch();
      notifyListeners();
    }
    return r;
  }

  /// Шаг 3: проверка лица. Вход выполняется только при [FaceResult.match].
  Future<FaceResult> verifyFace(Uint8List image) async {
    final token = _pendingToken;
    if (token == null) return FaceResult.error;

    final r = await _api.verifyFace(token, image);
    // Пока шла проверка, вход могли отменить (бездействие, «Назад»).
    if (_pendingToken != token) return FaceResult.error;

    if (r.expired) {
      loginNotice = 'sessionExpired';
      cancelPending();
      return FaceResult.error;
    }
    if (r.locked) {
      loginNotice = 'accountLocked';
      cancelPending();
      return FaceResult.noMatch;
    }
    if (r.result == FaceResult.match && r.soldier != null) {
      soldier = r.soldier;
      _balance = r.balance;
      _favorites = {...r.favorites};
      _pendingToken = null;
      touch();
      notifyListeners();
      unawaited(loadCatalog());
      return FaceResult.match;
    }

    final left = r.attemptsLeft;
    if (left != null) faceAttemptsLeft = left;
    notifyListeners();
    return r.result == FaceResult.match ? FaceResult.error : r.result;
  }

  /// Отмена входа на шаге проверки лица.
  void cancelPending() {
    _idle?.cancel();
    _pendingToken = null;
    notifyListeners();
  }

  void logout() {
    _idle?.cancel();
    final wasLoggedIn = soldier != null;
    soldier = null;
    _pendingToken = null;
    _balance = 0;
    _cart.clear();
    _favorites = {};
    catalog = const [];
    catalogLoading = false;
    catalogFailed = false;
    filter = null;
    query = '';
    favoritesOnly = false;
    _orderRequestId = null;
    placingOrder = false;
    orders = const [];
    ordersLoading = false;
    ordersFailed = false;
    chat.clear();
    assistantBusy = false;
    if (wasLoggedIn) unawaited(_api.logout());
    notifyListeners();
  }

  /// Сервер сказал, что сеанс закрыт (просрочен): возвращаем на экран входа.
  void _sessionExpired() {
    loginNotice = 'sessionExpired';
    logout();
  }

  /// Вызывается при любом касании экрана.
  ///
  void touch() {
    _idle?.cancel();
    if (!loggedIn && !hasPending) return;
    _idle = Timer(idleTimeout, logout);
  }

  // ---------- каталог ----------

  List<Product> catalog = const [];
  bool catalogLoading = false;
  bool catalogFailed = false;
  Category? filter;
  String query = '';

  Future<void> loadCatalog() async {
    catalogLoading = true;
    catalogFailed = false;
    notifyListeners();
    try {
      final items = await _api.catalog();
      if (!loggedIn) return; // вышли, пока шла загрузка
      catalog = items;
      _reconcileCart();
    } on ApiException catch (e) {
      if (e.unauthorized) {
        _sessionExpired();
        return;
      }
      catalogFailed = true;
    } catch (_) {
      catalogFailed = true;
    } finally {
      catalogLoading = false;
      notifyListeners();
    }
  }

  /// После обновления каталога убираем из корзины то, чего больше нет,
  /// и подрезаем количество до остатка.
  void _reconcileCart() {
    final fresh = {for (final p in catalog) p.id: p};
    var changed = false;
    for (final id in _cart.keys.toList()) {
      final p = fresh[id];
      if (p == null || p.stock <= 0) {
        _cart.remove(id);
        changed = true;
        continue;
      }
      final old = _cart[id]!.qty;
      final qty = min(old, p.stock);
      if (qty != old) changed = true;
      _cart[id] = CartLine(p, qty);
    }
    // Состав корзины изменился, значит это уже другой заказ.
    if (changed) _orderRequestId = null;
  }

  List<Product> get visibleProducts {
    final q = query.trim().toLowerCase();
    return catalog.where((p) {
      if (favoritesOnly && !_favorites.contains(p.id)) return false;
      if (filter != null && p.category != filter) return false;
      if (q.isEmpty) return true;
      return p.nameRu.toLowerCase().contains(q) ||
          p.nameKk.toLowerCase().contains(q);
    }).toList();
  }

  void setLang(String l) {
    lang = l;
    notifyListeners();
  }

  void setFilter(Category? c) {
    filter = c;
    notifyListeners();
  }

  void setQuery(String q) {
    query = q;
    notifyListeners();
  }

  // ---------- история заказов ----------

  /// Заказы вошедшего человека, новые сверху. Сервер отдаёт только его собственные.
  List<OrderRecord> orders = const [];
  bool ordersLoading = false;
  bool ordersFailed = false;

  Future<void> loadOrders() async {
    ordersLoading = true;
    ordersFailed = false;
    notifyListeners();
    try {
      final list = await _api.orders();
      if (!loggedIn) return; // вышли, пока шла загрузка
      orders = list;
    } on ApiException catch (e) {
      if (e.unauthorized) {
        _sessionExpired();
        return;
      }
      ordersFailed = true;
    } catch (_) {
      ordersFailed = true;
    } finally {
      ordersLoading = false;
      notifyListeners();
    }
  }

  // ---------- помощник ----------

  /// Переписка с помощником. Очищается при выходе, чужие вопросы следующий человек не увидит.
  final List<ChatMessage> chat = [];
  bool assistantBusy = false;

  /// Вопрос помощнику. Отвечает сервер (по правилам, при желании с локальной моделью).
  Future<void> askAssistant(String text) async {
    final q = text.trim();
    if (q.isEmpty || assistantBusy || !loggedIn) return;
    chat.add(ChatMessage.user(q));
    assistantBusy = true;
    notifyListeners();

    ChatMessage reply;
    try {
      final r = await _api.assistant(q, lang);
      reply = ChatMessage.bot(r.reply,
          products: r.products, cart: r.cart, suggestions: r.suggestions);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        _sessionExpired();
        return;
      }
      reply = ChatMessage.bot(s.t(e.status == 429 ? 'assistantSlow' : 'assistantError'));
    } catch (_) {
      reply = ChatMessage.bot(s.t('assistantError'));
    }
    if (!loggedIn) return; // вышли, пока ждали ответ
    chat.add(reply);
    assistantBusy = false;
    notifyListeners();
  }

  /// Кладёт предложенные помощником товары в корзину (не больше остатка).
  /// Возвращает, сколько штук добавлено. Оформляет заказ человек сам в корзине.
  int addAssistantItems(List<AssistantItem> items) {
    var added = 0;
    for (final it in items) {
      final matches = catalog.where((p) => p.id == it.id);
      if (matches.isEmpty) continue;
      final p = matches.first;
      for (var i = 0; i < it.qty && qtyOf(p) < stockOf(p); i++) {
        final line = _cart[p.id];
        if (line == null) {
          _cart[p.id] = CartLine(p, 1);
        } else {
          line.qty++;
        }
        added++;
      }
    }
    if (added > 0) {
      _orderRequestId = null;
      notifyListeners();
    }
    return added;
  }

  // ---------- избранное ----------

  Set<String> _favorites = {};
  bool favoritesOnly = false;

  bool isFavorite(Product p) => _favorites.contains(p.id);
  int get favoritesCount => _favorites.length;

  void setFavoritesOnly(bool v) {
    favoritesOnly = v;
    notifyListeners();
  }

  /// Сердечко меняется сразу, а на сервере сохраняется в фоне.
  /// Если сохранить не удалось, возвращаем как было.
  Future<void> toggleFavorite(Product p) async {
    final nowFav = !_favorites.contains(p.id);
    _setLocalFavorite(p.id, nowFav);
    try {
      await _api.setFavorite(p.id, nowFav);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        _sessionExpired();
      } else {
        _setLocalFavorite(p.id, !nowFav);
      }
    } catch (_) {
      _setLocalFavorite(p.id, !nowFav);
    }
  }

  void _setLocalFavorite(String id, bool value) {
    if (!loggedIn) return;
    if (value) {
      _favorites.add(id);
    } else {
      _favorites.remove(id);
    }
    notifyListeners();
  }

  // ---------- корзина и заказ ----------

  final Map<String, CartLine> _cart = {};
  bool placingOrder = false;

  /// Один и тот же идентификатор для повторных отправок той же корзины:
  /// если связь оборвалась после списания, повтор не спишет деньги дважды.
  String? _orderRequestId;

  List<CartLine> get cartLines => _cart.values.toList();
  int get cartCount => _cart.values.fold(0, (a, l) => a + l.qty);
  int get cartTotal => _cart.values.fold(0, (a, l) => a + l.total);
  int stockOf(Product p) => p.stock;
  int qtyOf(Product p) => _cart[p.id]?.qty ?? 0;
  bool get canAfford => cartTotal <= balance;

  void add(Product p) {
    final have = qtyOf(p);
    if (have >= stockOf(p)) return;
    final line = _cart[p.id];
    if (line == null) {
      _cart[p.id] = CartLine(p, 1);
    } else {
      line.qty++;
    }
    _orderRequestId = null;
    notifyListeners();
  }

  void remove(Product p) {
    final line = _cart[p.id];
    if (line == null) return;
    line.qty--;
    if (line.qty <= 0) _cart.remove(p.id);
    _orderRequestId = null;
    notifyListeners();
  }

  void clearCart() {
    _cart.clear();
    _orderRequestId = null;
    notifyListeners();
  }

  String _newRequestId() {
    final r = Random.secure();
    return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'))
        .join();
  }

  /// Оформляет заказ на сервере. Деньги списывает и код выдачи создаёт сервер.
  Future<OrderResponse> placeOrder() async {
    if (_cart.isEmpty || placingOrder) {
      return const OrderResponse(failure: OrderFailure.other);
    }
    placingOrder = true;
    notifyListeners();

    final requestId = _orderRequestId ??= _newRequestId();
    OrderResponse r;
    try {
      r = await _api.placeOrder(cartLines, requestId);
    } catch (_) {
      r = const OrderResponse(failure: OrderFailure.network);
    }
    if (!loggedIn) return r; // пока ждали ответ, сеанс закрылся
    placingOrder = false;

    if (r.ok) {
      _balance = r.balance;
      _cart.clear();
      _orderRequestId = null;
      notifyListeners();
      unawaited(loadCatalog()); // свежие остатки
      return r;
    }
    if (r.failure == OrderFailure.sessionExpired) {
      _sessionExpired();
      return r;
    }
    if (r.failure == OrderFailure.outOfStock) {
      unawaited(loadCatalog()); // обновит остатки и поправит корзину
    }
    notifyListeners();
    return r;
  }

  @override
  void dispose() {
    _idle?.cancel();
    super.dispose();
  }
}

class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child})
      : super(notifier: state);

  static AppState of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
}
