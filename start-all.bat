@echo off
echo ========================================
echo   TODO GAME - Starting All Services
echo ========================================
echo.

REM Check if .env exists
if not exist .env (
    echo [WARNING] .env file not found! Copying from .env.example...
    copy .env.example .env
    echo [INFO] Please edit .env file with your configuration
    echo [INFO] Press any key to continue...
    pause > nul
)

echo [INFO] Starting Flask server...
start "Flask Server" cmd /k "python server.py"

timeout /t 3 /nobreak > nul

echo [INFO] Starting Telegram bot...
cd telegram
start "Telegram Bot" cmd /k "node run.js"
cd ..

echo.
echo ========================================
echo   All services started!
echo ========================================
echo.
echo   - Web: http://localhost:5000
echo   - Telegram Bot: Check @BotFather
echo.
echo Press Ctrl+C to stop this script (services will continue running)
echo To stop all services, close the terminal windows
echo.
pause
