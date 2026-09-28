@echo off
setlocal
title CosmicV EdgeCrunch Darkroom Web Server
cd /d "%~dp0"

set "PY="
where py >nul 2>nul
if %errorlevel%==0 set "PY=py -3"

if not defined PY (
  where python >nul 2>nul
  if %errorlevel%==0 set "PY=python"
)

if not defined PY (
  echo Python 3 was not found.
  echo.
  echo Install Python or launch the web build with another local HTTP server.
  echo.
  pause
  exit /b 1
)

echo.
echo ================================================
echo   CosmicV EdgeCrunch Darkroom Web
echo ================================================
echo.
echo Serving:
echo   http://127.0.0.1:8000/
echo.
echo Leave this window OPEN while using CosmicV Web.
echo Close this window or press Ctrl+C to stop the server.
echo.

start "" "http://127.0.0.1:8000/"
%PY% -m http.server 8000 --bind 127.0.0.1

echo.
echo CosmicV Web server stopped.
pause
