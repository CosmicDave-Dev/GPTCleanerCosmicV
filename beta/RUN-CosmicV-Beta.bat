@echo off
setlocal

set "SCRIPT=%~dp0CosmicV-EdgeCrunch-Darkroom-Beta.py"

if not exist "%SCRIPT%" (
  echo CosmicV beta script was not found:
  echo %SCRIPT%
  echo.
  pause
  exit /b 2
)

where pyw.exe >nul 2>nul
if %errorlevel%==0 (
  start "" pyw.exe -3 "%SCRIPT%"
  exit /b 0
)

where pythonw.exe >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw.exe "%SCRIPT%"
  exit /b 0
)

where py.exe >nul 2>nul
if %errorlevel%==0 (
  py.exe -3 "%SCRIPT%"
  exit /b %errorlevel%
)

where python.exe >nul 2>nul
if %errorlevel%==0 (
  python.exe "%SCRIPT%"
  exit /b %errorlevel%
)

echo Python could not be found on PATH.
echo.
echo This beta expects Python 3 with numpy, opencv-python-headless, and pillow installed.
echo.
pause
exit /b 3
