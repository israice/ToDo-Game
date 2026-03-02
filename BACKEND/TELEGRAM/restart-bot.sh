#!/bin/sh
# Graceful restart for Telegram bot
# Called from webhook after code update

BOT_PID_FILE="/tmp/telegram-bot.pid"

# Get current bot PID
if [ -f "$BOT_PID_FILE" ]; then
    OLD_PID=$(cat "$BOT_PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Sending SIGUSR2 to bot (PID: $OLD_PID) for graceful restart..."
        kill -USR2 "$OLD_PID"
        echo "Bot restart signal sent"
    else
        echo "Bot not running, will start fresh"
    fi
else
    echo "No PID file found, bot not running"
fi
