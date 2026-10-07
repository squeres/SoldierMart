import 'dart:io' show File;
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart' show kIsWeb, kReleaseMode;
import 'package:flutter/material.dart';

import '../services/face_verifier.dart';
import '../state/app_state.dart';
import 'catalog_screen.dart';

/// Только для разработки без камеры: `--dart-define=DEV_FAKE_CAMERA=true`.
/// Вместо снимка уходят пустые байты. Настоящий сервер такой «снимок» отклонит,
/// пройти он может лишь на сервере в демо-режиме (`npm run dev`). В release-сборке не работает.
const bool kDevFakeCamera = bool.fromEnvironment('DEV_FAKE_CAMERA');

/// Шаг 3 входа: обязательная проверка лица.
/// Если камеры нет или доступ запрещён, войти нельзя: обхода нет.
class FaceScreen extends StatefulWidget {
  const FaceScreen({super.key});

  @override
  State<FaceScreen> createState() => _FaceScreenState();
}

class _FaceScreenState extends State<FaceScreen> {
  CameraController? _ctrl;
  bool _cameraFailed = false;
  bool _fakeCamera = false;
  bool _busy = false;
  FaceResult? _last;

  @override
  void initState() {
    super.initState();
    _initCamera();
  }

  Future<void> _initCamera() async {
    try {
      final cams = await availableCameras();
      if (cams.isEmpty) throw StateError('no camera');
      final cam = cams.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cams.first,
      );
      final ctrl = CameraController(cam, ResolutionPreset.medium,
          enableAudio: false);
      await ctrl.initialize();
      if (!mounted) {
        await ctrl.dispose();
        return;
      }
      setState(() => _ctrl = ctrl);
    } catch (_) {
      if (!mounted) return;
      if (kDevFakeCamera && !kReleaseMode) {
        setState(() => _fakeCamera = true);
      } else {
        setState(() => _cameraFailed = true);
      }
    }
  }

  @override
  void dispose() {
    _ctrl?.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final ctrl = _ctrl;
    if ((ctrl == null && !_fakeCamera) || _busy) return;
    final app = AppScope.of(context);
    setState(() {
      _busy = true;
      _last = null;
    });

    FaceResult result = FaceResult.error;
    try {
      final Uint8List bytes;
      if (ctrl == null) {
        bytes = Uint8List.fromList(const [0xFF, 0xD8, 0xFF, 0xD9]); // виртуальная камера
      } else {
        final shot = await ctrl.takePicture();
        bytes = await shot.readAsBytes();
        // Снимок лица не должен оставаться на терминале.
        if (!kIsWeb) {
          try {
            await File(shot.path).delete();
          } catch (_) {}
        }
      }
      result = await app.verifyFace(bytes);
    } catch (_) {
      result = FaceResult.error;
    }

    if (!mounted) return; // сеанс закрыт (блокировка, бездействие)
    if (result == FaceResult.match) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const CatalogScreen()),
      );
      return;
    }
    setState(() {
      _busy = false;
      _last = result;
    });
  }

  String? _message(AppState app) {
    final s = app.s;
    switch (_last) {
      case FaceResult.noMatch:
        return '${s.t('faceNoMatch')} ${s.t('faceAttemptsLeft')}: ${app.faceAttemptsLeft}';
      case FaceResult.noFace:
        return s.t('faceNoFace');
      case FaceResult.error:
        return s.t('faceError');
      case FaceResult.match:
      case null:
        return null;
    }
  }

  Widget _preview(BuildContext context, double size) {
    final cs = Theme.of(context).colorScheme;
    final ctrl = _ctrl;
    Widget inner;
    if (_cameraFailed) {
      inner = Padding(
        padding: const EdgeInsets.all(24),
        child: Center(
          child: Text(
            AppScope.of(context).s.t('faceNoCamera'),
            textAlign: TextAlign.center,
            style: TextStyle(color: cs.error, fontSize: 16),
          ),
        ),
      );
    } else if (_fakeCamera) {
      inner = const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.videocam_off, size: 48),
            SizedBox(height: 8),
            Text('DEV: виртуальная камера', textAlign: TextAlign.center),
          ],
        ),
      );
    } else if (ctrl == null) {
      inner = const Center(child: CircularProgressIndicator());
    } else {
      final ar = ctrl.value.aspectRatio; // ширина / высота (альбомная ориентация)
      final landscape =
          MediaQuery.of(context).orientation == Orientation.landscape;
      inner = FittedBox(
        fit: BoxFit.cover,
        clipBehavior: Clip.hardEdge,
        child: SizedBox(
          width: landscape ? 100 * ar : 100,
          height: landscape ? 100 : 100 * ar,
          child: CameraPreview(ctrl),
        ),
      );
    }
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: cs.surfaceContainerHighest,
        border: Border.all(color: cs.primary, width: 4),
      ),
      clipBehavior: Clip.antiAlias,
      child: inner,
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final s = app.s;
    final cs = Theme.of(context).colorScheme;
    final msg = _message(app);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.face_retouching_natural,
                      size: 48, color: cs.primary),
                  const SizedBox(height: 8),
                  Text(s.t('faceTitle'),
                      style: Theme.of(context)
                          .textTheme
                          .headlineSmall
                          ?.copyWith(fontWeight: FontWeight.bold)),
                  const SizedBox(height: 6),
                  Text(s.t('faceHint'),
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 17)),
                  const SizedBox(height: 18),
                  _preview(context, 280),
                  const SizedBox(height: 14),
                  if (app.faceDemo)
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: cs.tertiaryContainer,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text(s.t('faceDemoBanner'),
                          textAlign: TextAlign.center,
                          style: TextStyle(
                              color: cs.onTertiaryContainer, fontSize: 14)),
                    ),
                  SizedBox(
                    height: 48,
                    child: Center(
                      child: msg == null
                          ? null
                          : Text(msg,
                              textAlign: TextAlign.center,
                              style: TextStyle(color: cs.error, fontSize: 16)),
                    ),
                  ),
                  SizedBox(
                    width: double.infinity,
                    height: 64,
                    child: FilledButton.icon(
                      onPressed: ((_ctrl == null && !_fakeCamera) || _busy) ? null : _scan,
                      icon: _busy
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(strokeWidth: 3))
                          : const Icon(Icons.camera_alt),
                      label: Text(
                          _busy ? s.t('faceChecking') : s.t('faceScan'),
                          style: const TextStyle(fontSize: 22)),
                    ),
                  ),
                  const SizedBox(height: 10),
                  SizedBox(
                    width: double.infinity,
                    height: 56,
                    child: OutlinedButton(
                      onPressed: _busy ? null : app.cancelPending,
                      child: Text(s.t('back'),
                          style: const TextStyle(fontSize: 18)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
