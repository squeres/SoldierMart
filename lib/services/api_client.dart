import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../models/product.dart';
import 'face_verifier.dart';

// ---------- ответы сервера в удобном для приложения виде ----------

enum LoginStatus {
  /// ИИН и ПИН верны (дальше обязательна проверка лица).
  ok,

  /// Неверный ИИН или ПИН.
  wrong,

  /// Аккаунт заблокирован: вход невозможен, даже с верным ПИН.
  locked,

  /// Нет связи с сервером или он вернул ошибку.
  networkError,
}

class LoginResponse {
  const LoginResponse(
    this.status, {
    this.pendingToken,
    this.attemptsLeft,
    this.faceAttemptsLeft,
    this.faceDemo = false,
  });

  final LoginStatus status;

  /// Токен шага «лицо». Это ещё не вход и к данным не даёт доступа.
  final String? pendingToken;

  /// Сколько попыток ПИН осталось до блокировки (при [LoginStatus.wrong]).
  final int? attemptsLeft;
  final int? faceAttemptsLeft;

  /// Сервер сообщает, что проверка лица работает в демо-режиме.
  final bool faceDemo;
}

class FaceResponse {
  const FaceResponse(
    this.result, {
    this.attemptsLeft,
    this.locked = false,
    this.expired = false,
    this.soldier,
    this.balance = 0,
    this.favorites = const {},
  });

  final FaceResult result;
  final int? attemptsLeft;

  /// Аккаунт заблокирован (слишком много неудачных проверок лица).
  final bool locked;

  /// Шаг проверки лица просрочен, нужно начать вход заново.
  final bool expired;

  // Данные после успешного входа:
  final Soldier? soldier;
  final int balance;
  final Set<String> favorites;
}

enum OrderFailure { insufficientFunds, outOfStock, network, sessionExpired, other }

class OrderResponse {
  const OrderResponse({this.code, this.balance = 0, this.failure});

  /// Код выдачи заказа (только при успехе).
  final String? code;
  final int balance;
  final OrderFailure? failure;

  bool get ok => failure == null && code != null;
}

/// Ошибка обращения к серверу. [status] == null означает «нет связи».
class ApiException implements Exception {
  ApiException(this.status);
  final int? status;

  bool get unauthorized => status == 401;
  bool get network => status == null;

  @override
  String toString() => 'ApiException($status)';
}

/// Всё, что приложению нужно от сервера. Отдельный интерфейс позволяет
/// подменять сервер в тестах.
abstract class Backend {
  Future<LoginResponse> login(String iin, String pin);
  Future<FaceResponse> verifyFace(String pendingToken, Uint8List image);
  Future<List<Product>> catalog();
  Future<void> setFavorite(String productId, bool value);
  Future<OrderResponse> placeOrder(List<CartLine> lines, String requestId);
  Future<void> logout();
}

// ---------- реализация по HTTP ----------

class ApiClient implements Backend {
  ApiClient({String? baseUrl, http.Client? client})
      : baseUrl = baseUrl ?? defaultBaseUrl(),
        _http = client ?? http.Client();

  /// Адрес сервера. Задаётся при запуске: `--dart-define=API_URL=http://192.168.0.10:8080`.
  /// По умолчанию: `localhost` для Chrome и компьютера, `10.0.2.2` для эмулятора Android
  /// (так эмулятор видит локальный компьютер).
  static String defaultBaseUrl() {
    const fromEnv = String.fromEnvironment('API_URL');
    if (fromEnv.isNotEmpty) return fromEnv;
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:8080';
    }
    return 'http://localhost:8080';
  }

  final String baseUrl;
  final http.Client _http;
  static const Duration _timeout = Duration(seconds: 10);

  /// Токен сеанса. Живёт только в памяти и выдаётся сервером после проверки лица.
  String? _session;

  Future<http.Response> _send(
    String method,
    String path, {
    Object? body,
    bool auth = false,
    String? bearer,
  }) async {
    try {
      final req = http.Request(method, Uri.parse('$baseUrl$path'));
      if (body != null) {
        req.headers['Content-Type'] = 'application/json';
        req.body = jsonEncode(body);
      }
      final token = bearer ?? (auth ? _session : null);
      if (token != null) req.headers['Authorization'] = 'Bearer $token';
      final streamed = await _http.send(req).timeout(_timeout);
      return await http.Response.fromStream(streamed).timeout(_timeout);
    } on Exception {
      // Нет сети, таймаут, сервер не запущен и т. п.
      throw ApiException(null);
    }
  }

  Map<String, dynamic> _json(http.Response r) {
    try {
      final v = jsonDecode(utf8.decode(r.bodyBytes));
      return v is Map<String, dynamic> ? v : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  int? _int(Object? v) => v is num ? v.toInt() : null;

  @override
  Future<LoginResponse> login(String iin, String pin) async {
    try {
      final r = await _send('POST', '/api/login', body: {'iin': iin, 'pin': pin});
      final j = _json(r);
      switch (r.statusCode) {
        case 200:
          final token = j['pendingToken'];
          if (token is! String) return const LoginResponse(LoginStatus.networkError);
          return LoginResponse(
            LoginStatus.ok,
            pendingToken: token,
            faceAttemptsLeft: _int(j['faceAttemptsLeft']),
            faceDemo: j['faceDemo'] == true,
          );
        case 401:
          return LoginResponse(LoginStatus.wrong, attemptsLeft: _int(j['attemptsLeft']));
        case 423:
          return const LoginResponse(LoginStatus.locked);
        default:
          return const LoginResponse(LoginStatus.networkError);
      }
    } catch (_) {
      return const LoginResponse(LoginStatus.networkError);
    }
  }

  @override
  Future<FaceResponse> verifyFace(String pendingToken, Uint8List image) async {
    try {
      final r = await _send('POST', '/api/face', body: {
        'pendingToken': pendingToken,
        'image': base64Encode(image),
      });
      final j = _json(r);
      switch (r.statusCode) {
        case 200:
          final res = j['result'];
          if (res == 'match') {
            final session = j['sessionToken'];
            final u = j['user'];
            if (session is! String || u is! Map<String, dynamic>) {
              return const FaceResponse(FaceResult.error);
            }
            _session = session;
            return FaceResponse(
              FaceResult.match,
              soldier: Soldier(name: u['name'] as String, unit: u['unit'] as String),
              balance: _int(j['balance']) ?? 0,
              favorites: {...((j['favorites'] as List?) ?? const []).cast<String>()},
            );
          }
          return FaceResponse(
            res == 'noMatch'
                ? FaceResult.noMatch
                : res == 'noFace'
                    ? FaceResult.noFace
                    : FaceResult.error,
            attemptsLeft: _int(j['attemptsLeft']),
          );
        case 423:
          return const FaceResponse(FaceResult.noMatch, locked: true);
        case 401:
          return const FaceResponse(FaceResult.error, expired: true);
        default:
          return const FaceResponse(FaceResult.error);
      }
    } catch (_) {
      return const FaceResponse(FaceResult.error);
    }
  }

  @override
  Future<List<Product>> catalog() async {
    final r = await _send('GET', '/api/catalog', auth: true);
    if (r.statusCode != 200) throw ApiException(r.statusCode);
    final list = (_json(r)['products'] as List).cast<Map<String, dynamic>>();
    return list.map(Product.fromJson).toList();
  }

  @override
  Future<void> setFavorite(String productId, bool value) async {
    final r = await _send(value ? 'PUT' : 'DELETE', '/api/favorites/$productId', auth: true);
    if (r.statusCode != 200) throw ApiException(r.statusCode);
  }

  @override
  Future<OrderResponse> placeOrder(List<CartLine> lines, String requestId) async {
    try {
      final r = await _send('POST', '/api/orders', auth: true, body: {
        'requestId': requestId,
        // Цены считает сервер: от клиента нужно только «что и сколько».
        'items': [
          for (final l in lines) {'productId': l.product.id, 'qty': l.qty},
        ],
      });
      final j = _json(r);
      if (r.statusCode == 200 || r.statusCode == 201) {
        final order = j['order'];
        final code = order is Map<String, dynamic> ? order['code'] : null;
        if (code is! String) return const OrderResponse(failure: OrderFailure.other);
        return OrderResponse(code: code, balance: _int(j['balance']) ?? 0);
      }
      if (r.statusCode == 401) {
        return const OrderResponse(failure: OrderFailure.sessionExpired);
      }
      if (r.statusCode == 409) {
        return OrderResponse(
          failure: j['error'] == 'out_of_stock'
              ? OrderFailure.outOfStock
              : OrderFailure.insufficientFunds,
        );
      }
      return const OrderResponse(failure: OrderFailure.other);
    } on ApiException {
      return const OrderResponse(failure: OrderFailure.network);
    } catch (_) {
      return const OrderResponse(failure: OrderFailure.other);
    }
  }

  @override
  Future<void> logout() async {
    final token = _session;
    _session = null; // локально выходим сразу, не дожидаясь сервера
    if (token == null) return;
    try {
      await _send('POST', '/api/logout', bearer: token);
    } catch (_) {
      // Не страшно: сеанс на сервере всё равно закроется по времени.
    }
  }
}
