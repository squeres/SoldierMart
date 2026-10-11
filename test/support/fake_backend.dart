import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:soldiermart/models/assistant.dart';
import 'package:soldiermart/models/product.dart';
import 'package:soldiermart/services/api_client.dart';
import 'package:soldiermart/services/face_verifier.dart';

const kWater = Product(
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
  var loginCalls = 0;
  Duration? loginDelay;

  @override
  Future<LoginResponse> login(String iin, String pin) async {
    loginCalls++;
    if (loginDelay != null) await Future<void>.delayed(loginDelay!);
    return loginResult;
  }

  @override
  Future<FaceResponse> verifyFace(String t, Uint8List image) async => faceResult;

  @override
  Future<List<Product>> catalog() async {
    if (catalogError != null) throw catalogError!;
    return [kWater];
  }

  @override
  Future<void> setFavorite(String id, bool v) async {}

  @override
  Future<OrderResponse> placeOrder(List<CartLine> lines, String requestId) async {
    requestIds.add(requestId);
    return orderResult;
  }

  AssistantReply assistantResult = const AssistantReply(reply: 'Привет');
  Object? assistantError;
  final assistantQuestions = <String>[];

  @override
  Future<AssistantReply> assistant(String message, String lang) async {
    assistantQuestions.add('$lang:$message');
    if (assistantError != null) throw assistantError!;
    return assistantResult;
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

