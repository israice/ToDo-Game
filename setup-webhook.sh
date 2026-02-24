#!/bin/bash

# GitHub Webhook Setup Script
# This script helps you configure GitHub webhook for auto-deploy

echo "========================================"
echo "  GitHub Webhook Setup for TODO GAME"
echo "========================================"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "[ERROR] .env file not found!"
    echo "Please copy .env.example to .env and configure it first:"
    echo "  cp .env.example .env"
    exit 1
fi

# Read WEBHOOK_SECRET from .env
WEBHOOK_SECRET=$(grep "^WEBHOOK_SECRET=" .env | cut -d'=' -f2 | tr -d '"')

if [ -z "$WEBHOOK_SECRET" ]; then
    echo "[ERROR] WEBHOOK_SECRET not set in .env"
    echo "Please set WEBHOOK_SECRET in .env file"
    exit 1
fi

# Get server URL
echo "Enter your server URL (e.g., https://todo.weforks.org):"
read -r SERVER_URL

if [ -z "$SERVER_URL" ]; then
    echo "[ERROR] Server URL cannot be empty"
    exit 1
fi

WEBHOOK_URL="${SERVER_URL}/webhook"

echo ""
echo "========================================"
echo "  GitHub Webhook Configuration"
echo "========================================"
echo ""
echo "Configure your GitHub repository webhook with these settings:"
echo ""
echo "  Payload URL:    ${WEBHOOK_URL}"
echo "  Content type:   application/json"
echo "  Secret:         ${WEBHOOK_SECRET}"
echo "  Events:         ✓ Just the push event"
echo ""
echo "Steps:"
echo "  1. Go to your GitHub repository"
echo "  2. Settings → Webhooks → Add webhook"
echo "  3. Enter the settings above"
echo "  4. Click 'Add webhook'"
echo ""
echo "========================================"
echo ""

# Optional: Test webhook
read -p "Do you want to test the webhook? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Sending test request..."
    curl -X POST "${WEBHOOK_URL}" \
        -H "Content-Type: application/json" \
        -H "X-GitHub-Event: push" \
        -H "X-Hub-Signature-256: sha256=$(echo -n '' | openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" | awk '{print $2}')" \
        -d '{"ref":"refs/heads/master"}' \
        || echo "Test request failed"
fi

echo ""
echo "Done!"
