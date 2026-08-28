@echo off
setlocal
cd /d "%~dp0"

set NODE_DIR=%~dp0node-runtime

if exist "%NODE_DIR%\node.exe" (
    echo Using bundled Node.js runtime from node-runtime\
    set "PATH=%NODE_DIR%;%PATH%"
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo.
        echo ============================================
        echo   ERROR: Node.js was not found.
        echo   Either install Node.js from https://nodejs.org
        echo   or make sure the "node-runtime" folder is
        echo   present next to this script.
        echo ============================================
        echo.
        pause
        exit /b 1
    )
    echo Using system-installed Node.js
)

if not exist "%~dp0node_modules" (
    echo.
    echo node_modules not found - installing dependencies first.
    echo This requires an internet connection and may take a minute...
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
)

echo.
echo ============================================
echo   Starting Bridge Server...
echo.
echo   When you see "network:" below, that is the
echo   link to send to the other players/spectators
echo   on this same WiFi/network.
echo ============================================
echo.

call npm.cmd run dev:multi

echo.
echo ------------------------------------------------
echo Server has stopped. Press any key to close this window.
echo ------------------------------------------------
pause >nul
