@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  py -3.12 -m venv .venv || goto :error
)

echo [1/3] Installing build dependencies...
".venv\Scripts\python.exe" -m pip install -r requirements-dev.lock || goto :error

echo [2/3] Building NVIDIAChat.exe...
".venv\Scripts\python.exe" scripts\build_icon.py || goto :error
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean NVIDIAChat.spec || goto :error

echo [3/3] Verifying output...
if not exist "dist\NVIDIAChat.exe" goto :error
".venv\Scripts\python.exe" scripts\refresh_shortcuts.py || goto :error
echo.
echo Build complete: dist\NVIDIAChat.exe
exit /b 0

:error
echo.
echo Build failed. See the error above.
exit /b 1
