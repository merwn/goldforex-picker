@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

title GoldForex Picker

echo ========================================================
echo               GoldForex Picker Launcher                 
echo ========================================================
echo.

:: Detect Python launcher (py.exe) or python.exe
where py >nul 2>&1
if !ERRORLEVEL! equ 0 (
    set "PY_CMD=py"
) else (
    where python >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PY_CMD=python"
    ) else (
        echo [ERROR] Python was not found on your system!
        echo Please install Python from https://www.python.org/
        echo.
        pause
        exit /b 1
    )
)

echo Starting application using: !PY_CMD!
echo.
!PY_CMD! main.py %*

if !ERRORLEVEL! neq 0 (
    echo.
    echo Application exited with code !ERRORLEVEL!.
    pause
)

