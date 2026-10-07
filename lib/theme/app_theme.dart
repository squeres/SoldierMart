import 'package:flutter/material.dart';

/// Фирменная палитра SoldierMart.
class Brand {
  Brand._();

  /// Фон приложения.
  static const night = Color(0xFF021024);

  /// Шапка, карточки, поля.
  static const navy = Color(0xFF052659);

  /// Акцент: плитки товаров, вторичные кнопки, рамки.
  static const steel = Color(0xFF5483B3);

  /// Основные кнопки, выбранные элементы.
  static const sky = Color(0xFF7DA0CA);

  /// Текст и значки на тёмном фоне.
  static const ice = Color(0xFFC1E8FF);

  /// Красный для избранного (на тёмной подложке).
  static const heart = Color(0xFFFF6B6B);
}

ThemeData buildTheme() {
  const scheme = ColorScheme(
    brightness: Brightness.dark,
    primary: Brand.sky,
    onPrimary: Brand.night,
    primaryContainer: Brand.steel,
    onPrimaryContainer: Brand.night,
    secondary: Brand.steel,
    onSecondary: Brand.night,
    secondaryContainer: Brand.steel,
    onSecondaryContainer: Brand.night,
    tertiary: Brand.ice,
    onTertiary: Brand.night,
    tertiaryContainer: Brand.ice,
    onTertiaryContainer: Brand.night,
    // Ошибки: красный нужен по смыслу, в палитре его нет.
    error: Color(0xFFFFB4AB),
    onError: Color(0xFF690005),
    errorContainer: Color(0xFF93000A),
    onErrorContainer: Color(0xFFFFDAD6),
    surface: Brand.night,
    onSurface: Brand.ice,
    surfaceContainerHighest: Brand.navy,
    onSurfaceVariant: Brand.sky,
    outline: Brand.steel,
    outlineVariant: Brand.navy,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: Brand.night,
    appBarTheme: const AppBarTheme(
      backgroundColor: Brand.navy,
      foregroundColor: Brand.ice,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
    ),
  );
}
