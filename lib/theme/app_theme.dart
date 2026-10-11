import 'package:flutter/material.dart';

/// Фирменная палитра SoldierMart: белый фон, насыщенный индиго-синий акцент,
/// чёрные заголовки и светлые карточки с мягкими скруглениями.
class Brand {
  Brand._();

  /// Фон приложения.
  static const white = Color(0xFFFFFFFF);

  /// Основной акцент: кнопки, цены, выбранные элементы, шапка логотипа.
  static const indigo = Color(0xFF3A3DE8);

  /// Нажатая кнопка и тёмный индиго.
  static const indigoDark = Color(0xFF2A2DB8);

  /// Бледно-лавандовая подложка: плитки значков товаров, код выдачи.
  static const lavender = Color(0xFFE4E5FF);

  /// Светло-серые карточки и поля.
  static const card = Color(0xFFF3F4FB);

  /// Рамки и разделители.
  static const line = Color(0xFFD5D8F2);

  /// Текст и заголовки: почти чёрный.
  static const ink = Color(0xFF0D0D1A);

  /// Приглушённый текст.
  static const mist = Color(0xFF5E6180);

  /// Избранное.
  static const heart = Color(0xFFE5484D);

  /// Успешный статус (заказ выдан).
  static const success = Color(0xFF1F9D55);
}

ThemeData buildTheme() {
  const scheme = ColorScheme(
    brightness: Brightness.light,
    primary: Brand.indigo,
    onPrimary: Brand.white,
    primaryContainer: Brand.lavender,
    onPrimaryContainer: Brand.indigo,
    secondary: Brand.lavender,
    onSecondary: Brand.indigo,
    secondaryContainer: Brand.lavender,
    onSecondaryContainer: Brand.ink,
    tertiary: Brand.ink,
    onTertiary: Brand.white,
    tertiaryContainer: Brand.lavender,
    onTertiaryContainer: Brand.ink,
    error: Color(0xFFD92D4A),
    onError: Brand.white,
    errorContainer: Color(0xFFFFE1E5),
    onErrorContainer: Color(0xFF7A0A1E),
    surface: Brand.white,
    onSurface: Brand.ink,
    surfaceContainerHighest: Brand.card,
    onSurfaceVariant: Brand.mist,
    outline: Brand.line,
    outlineVariant: Brand.line,
  );

  const pill = StadiumBorder();

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: Brand.white,
    appBarTheme: const AppBarTheme(
      backgroundColor: Brand.white,
      foregroundColor: Brand.ink,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      shape: Border(bottom: BorderSide(color: Brand.line)),
      titleTextStyle: TextStyle(
        color: Brand.ink,
        fontSize: 22,
        fontWeight: FontWeight.w800,
      ),
    ),
    // Кнопки-«таблетки» с жирным текстом, как в макете.
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        shape: pill,
        textStyle: const TextStyle(fontWeight: FontWeight.w800),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        shape: pill,
        side: const BorderSide(color: Brand.indigo, width: 1.5),
        foregroundColor: Brand.indigo,
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(shape: pill, foregroundColor: Brand.indigo),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(foregroundColor: Brand.ink),
    ),
    cardTheme: CardThemeData(
      color: Brand.card,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: const BorderSide(color: Brand.line),
      ),
    ),
    chipTheme: const ChipThemeData(
      shape: pill,
      backgroundColor: Brand.card,
      selectedColor: Brand.indigo,
      side: BorderSide(color: Brand.line),
      labelStyle: TextStyle(color: Brand.ink, fontWeight: FontWeight.w600),
      secondaryLabelStyle: TextStyle(color: Brand.white, fontWeight: FontWeight.w700),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Brand.card,
      hintStyle: const TextStyle(color: Brand.mist),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: const BorderSide(color: Brand.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: const BorderSide(color: Brand.indigo, width: 2),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: Brand.indigo,
      contentTextStyle: TextStyle(color: Brand.white, fontWeight: FontWeight.w700),
      behavior: SnackBarBehavior.floating,
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: Brand.indigo),
    dividerTheme: const DividerThemeData(color: Brand.line, thickness: 0.8),
  );
}
