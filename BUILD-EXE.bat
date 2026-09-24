@echo off
setlocal EnableExtensions
title GPTCleaner CosmicV - Windows EXE Builder
cd /d "%~dp0"

echo.
echo ============================================================
echo        GPTCleaner CosmicV - One Click EXE Builder
echo ============================================================
echo.

set "PY="
where py >nul 2>nul
if %errorlevel%==0 set "PY=py -3"
if not defined PY (
    where python >nul 2>nul
    if %errorlevel%==0 set "PY=python"
)
if not defined PY (
    echo ERROR: Python 3 was not found.
    echo Install Python from https://www.python.org/downloads/windows/
    pause
    exit /b 1
)

echo [1/5] Preparing isolated build environment...
if not exist ".build-env\Scripts\python.exe" (
    %PY% -m venv ".build-env"
    if errorlevel 1 goto :failed
)
call ".build-env\Scripts\activate.bat"
if errorlevel 1 goto :failed

echo [2/5] Installing build dependencies...
python -m pip install --upgrade pip
if errorlevel 1 goto :failed
python -m pip install --upgrade pyinstaller
if errorlevel 1 goto :failed
python -m pip install -r requirements.txt
if errorlevel 1 goto :failed

echo [3/5] Cleaning previous output...
if exist "build" rmdir /s /q "build"
if exist "dist" rmdir /s /q "dist"
if exist "GPTCleanerCosmicV.spec" del /q "GPTCleanerCosmicV.spec"

echo [4/5] Building standalone executable...
python -m PyInstaller ^
    --noconfirm ^
    --clean ^
    --onefile ^
    --windowed ^
    --noupx ^
    --name "GPTCleanerCosmicV" ^
    --icon "assets\\CosmicDaveIcon.ico" ^
    --version-file "version_info.txt" ^
    --hidden-import "PIL._tkinter_finder" ^
    "GPTCleanerCosmicV.py"
if errorlevel 1 goto :failed

echo [5/5] Preparing release folder...
copy /y "LICENSE" "dist\LICENSE.txt" >nul
copy /y "docs\WINDOWS-EXE-INSTALL.txt" "dist\README.txt" >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$files=@('dist\GPTCleanerCosmicV.exe','dist\LICENSE.txt','dist\README.txt'); Compress-Archive -Force -Path $files -DestinationPath 'dist\GPTCleanerCosmicV-Windows-x64.zip'"

echo.
echo BUILD COMPLETE
echo Standalone EXE: %CD%\dist\GPTCleanerCosmicV.exe
echo Release ZIP:    %CD%\dist\GPTCleanerCosmicV-Windows-x64.zip
start "" "%CD%\dist"
pause
exit /b 0

:failed
echo.
echo BUILD FAILED. Scroll up for the first error.
pause
exit /b 1
