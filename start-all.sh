#!/bin/bash

echo "========================================"
echo "  TODO GAME - Starting All Services"
echo "========================================"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "[WARNING] .env file not found! Copying from .env.example..."
    cp .env.example .env
    echo "[INFO] Please edit .env file with your configuration"
fi

echo "[INFO] Starting Flask server..."
python server.py &
FLASK_PID=$!

sleep 3

echo "[INFO] Starting Telegram bot..."
cd telegram
node run.js &
BOT_PID=$!
cd ..

echo ""
echo "========================================"
echo "  All services started!"
echo "========================================"
echo ""
echo "  - Web: http://localhost:5000"
echo "  - Telegram Bot: Check @BotFather"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Trap Ctrl+C and kill all processes
trap "kill $FLASK_PID $BOT_PID 2>/dev/null; echo 'All services stopped'; exit" INT

# Wait for processes
wait
