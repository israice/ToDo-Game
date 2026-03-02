#!/bin/bash

# Server Setup Script for TODO GAME
# Run this on your server for initial setup

set -e

echo "========================================"
echo "  TODO GAME - Server Setup"
echo "========================================"
echo ""

# Check if running on Linux
if [[ "$(uname)" != "Linux" ]]; then
    echo "[ERROR] This script must run on Linux"
    exit 1
fi

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "[ERROR] Docker is not installed"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "[ERROR] docker-compose is not installed"
    exit 1
fi

# Check if .env exists
if [ ! -f .env ]; then
    echo "[INFO] .env not found. Creating from example..."
    cp .env.example .env
    echo ""
    echo "[WARN] Please edit .env with your configuration:"
    echo "  - SECRET_KEY"
    echo "  - WEBHOOK_SECRET"
    echo "  - REPO_URL"
    echo "  - TELEGRAM_BOT_TOKEN (optional)"
    echo ""
    read -p "Press Enter after you've edited .env..."
fi

# Build and start
echo "[INFO] Building and starting services..."
docker-compose up -d --build

echo ""
echo "========================================"
echo "  ✓ Setup complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. Configure GitHub webhook:"
echo "   Settings → Webhooks → Add webhook"
echo "   Payload URL: https://$(curl -s ifconfig.me):${PORT:-5010}/webhook"
echo ""
echo "2. View logs: docker-compose logs -f"
echo "3. Access: http://localhost:${PORT:-5010}"
echo ""
