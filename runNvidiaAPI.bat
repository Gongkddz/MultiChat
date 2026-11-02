@echo off
cd /d "%~dp0"
if exist "dist\NVIDIAChat.exe" (
  start "" "dist\NVIDIAChat.exe"
  exit /b 0
)
echo EXE not found. Run build_exe.bat first.
pause
