@echo off
rem ============================================================================
rem  SoldierMart: запуск для разработки (Windows). Сначала один раз выполните setup.cmd.
rem
rem  Что делает: запускает сервер (демо-режим, тестовый аккаунт, без камеры),
rem  ждёт, пока он ответит, и открывает приложение в Chrome с виртуальной камерой.
rem  Тестовый вход: ИИН 900101300007, ПИН 1111.
rem
rem    start-dev.cmd        запуск
rem    start-dev.cmd dry    только показать, что будет запущено
rem    start-dev.cmd server только сервер, без приложения
rem  Порт сервера: переменная PORT (по умолчанию 8080).
rem
rem  Остановка: Ctrl+C в окне сервера и в этом окне (не закрывайте окна крестиком:
rem  встроенная база может повредиться).
rem ============================================================================
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if exist "flutter\bin\flutter.bat" set "PATH=%CD%\flutter\bin;%PATH%"
if not defined PORT set "PORT=8080"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js не найден. Сначала запустите setup.cmd
  goto :fail
)
if not exist "backend\node_modules" (
  echo Пакеты сервера не установлены. Сначала запустите setup.cmd
  goto :fail
)
where flutter >nul 2>&1
if errorlevel 1 (
  echo Flutter не найден. Сначала запустите setup.cmd
  goto :fail
)

rem Если Ollama и маленькая модель уже есть, помощник будет отвечать умнее.
set "OLLAMA_MODEL="
where ollama >nul 2>&1
if not errorlevel 1 (
  ollama list 2>nul | find "qwen2.5:1.5b" >nul && set "OLLAMA_MODEL=qwen2.5:1.5b"
)
if defined OLLAMA_MODEL (echo Помощник: с локальной моделью %OLLAMA_MODEL%.) else (echo Помощник: по правилам, без нейросети.)

rem Порт уже занят? Скорее всего, сервер уже запущен.
curl -s -m 2 http://127.0.0.1:%PORT%/health >nul 2>&1
if not errorlevel 1 (
  echo Сервер уже работает на порту %PORT%, второй не запускаю.
  goto :app
)

echo Запускаю сервер в отдельном окне...
if /i "%~1"=="dry" (
  echo [dry] start "SoldierMart server" cmd /k "cd /d backend ^&^& npm run dev"
  goto :app
)
start "SoldierMart server" cmd /k "cd /d "%~dp0backend" && npm run dev"

echo Жду, пока сервер ответит...
set /a TRIES=0
:wait
set /a TRIES+=1
curl -s -m 2 http://127.0.0.1:%PORT%/health >nul 2>&1
if not errorlevel 1 goto :app
if %TRIES% GEQ 60 (
  echo Сервер не ответил за минуту. Посмотрите окно сервера.
  goto :fail
)
timeout /t 1 /nobreak >nul
goto :wait

:app
if /i "%~1"=="server" (
  echo Сервер работает: http://127.0.0.1:%PORT%  (панель дежурного: /panel)
  exit /b 0
)
echo Запускаю приложение в Chrome...
if /i "%~1"=="dry" (
  echo [dry] flutter run -d chrome --dart-define=DEV_FAKE_CAMERA=true --dart-define=API_URL=http://localhost:%PORT%
  exit /b 0
)
call flutter run -d chrome --dart-define=DEV_FAKE_CAMERA=true --dart-define=API_URL=http://localhost:%PORT%
exit /b %errorlevel%

:fail
echo.
if defined SM_NOPAUSE exit /b 1
echo %cmdcmdline% | find /i "/c" >nul && pause
exit /b 1
