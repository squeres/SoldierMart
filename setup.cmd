@echo off
rem ============================================================================
rem  SoldierMart: установка одним запуском (Windows).
rem  Ставит всё, что нужно проекту: Node.js (если нет), Flutter (если нет),
rem  пакеты сервера и приложения. Повторный запуск безопасен.
rem
rem    setup.cmd           обычная установка
rem    setup.cmd ollama    дополнительно скачать маленькую модель для помощника (около 1 ГБ)
rem ============================================================================
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo === SoldierMart: установка ===
echo.

rem ---------- 1. Node.js ----------
where node >nul 2>&1
if errorlevel 1 (
  echo [1/4] Node.js не найден.
  where winget >nul 2>&1
  if errorlevel 1 goto :no_node
  echo       Ставлю Node.js LTS через winget, подождите...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  echo.
  echo Node.js установлен. Закройте это окно и запустите setup.cmd ещё раз,
  echo чтобы система увидела новую программу.
  goto :end_fail
)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo [1/4] Нужен Node.js версии 18 или новее, у вас %NODE_MAJOR%. Обновите: https://nodejs.org
  goto :end_fail
)
echo [1/4] Node.js %NODE_MAJOR%: найден.

rem ---------- 2. Flutter ----------
where flutter >nul 2>&1
if not errorlevel 1 goto :flutter_ok
if exist "flutter\bin\flutter.bat" (
  set "PATH=%CD%\flutter\bin;%PATH%"
  goto :flutter_ok
)
echo [2/4] Flutter не найден.
where git >nul 2>&1
if errorlevel 1 goto :no_flutter
echo       Скачиваю Flutter SDK в папку flutter (около 1 ГБ, это один раз)...
git clone https://github.com/flutter/flutter.git -b stable --depth 1 flutter
if errorlevel 1 goto :no_flutter
set "PATH=%CD%\flutter\bin;%PATH%"
:flutter_ok
echo [2/4] Flutter: найден.

rem ---------- 3. Сервер ----------
echo [3/4] Ставлю пакеты сервера (первый раз около 300 МБ, нужен интернет)...
pushd backend
call npm install --no-audit --no-fund
if errorlevel 1 (
  popd
  echo Не удалось установить пакеты сервера.
  goto :end_fail
)
popd

rem ---------- 4. Приложение ----------
echo [4/4] Ставлю пакеты приложения...
call flutter config --enable-web >nul 2>&1
call flutter pub get
if errorlevel 1 (
  echo Не удалось установить пакеты приложения.
  goto :end_fail
)

rem ---------- Необязательно: модель для помощника ----------
if /i "%~1"=="ollama" (
  where ollama >nul 2>&1
  if errorlevel 1 (
    echo.
    echo Ollama не установлен, модель пропускаю: https://ollama.com/download
  ) else (
    echo.
    echo Скачиваю модель qwen2.5:1.5b для помощника...
    ollama pull qwen2.5:1.5b
  )
)

echo.
echo ============================================================
echo  Готово. Запуск для разработки без камеры: start-dev.cmd
echo  Тестовый вход: ИИН 900101300007, ПИН 1111
echo ============================================================
goto :end_ok

:no_node
echo       Установите Node.js LTS вручную: https://nodejs.org  и запустите setup.cmd снова.
goto :end_fail

:no_flutter
echo       Установите Flutter: https://docs.flutter.dev/get-started/install/windows
echo       (или установите Git и запустите setup.cmd снова: Flutter скачается сам).
goto :end_fail

:end_fail
echo.
echo Установка не завершена.
call :maybe_pause
exit /b 1

:end_ok
call :maybe_pause
exit /b 0

rem Пауза только при запуске двойным щелчком, чтобы окно не закрылось раньше, чем прочитаете.
:maybe_pause
if defined SM_NOPAUSE exit /b 0
echo %cmdcmdline% | find /i "/c" >nul && pause
exit /b 0
