# 🚀 Развёртывание на сервере

## Быстрый старт

```bash
# 1. Клонируйте репозиторий
git clone https://github.com/YOUR_USERNAME/todo-game.git
cd todo-game

# 2. Настройте .env
cp .env.example .env
nano .env  # Отредактируйте с вашими данными

# 3. Запустите
docker-compose up -d --build

# 4. Настройте webhook на GitHub
# Settings → Webhooks → Add webhook
# Payload URL: https://your-server.com/webhook
```

## 🔧 Конфигурация .env

```bash
# Обязательные
SECRET_KEY=your-secret-key-here
WEBHOOK_SECRET=your-webhook-secret-here
REPO_URL=https://github.com/YOUR_USERNAME/todo-game.git
BRANCH=master

# Порт
PORT=5010

# Telegram бот (опционально)
TELEGRAM_BOT_TOKEN=your-bot-token
ADMIN_TELEGRAM_ID=your-telegram-id
```

## 📦 Структура данных

Все данные хранятся в Docker volumes:
- `app_data` → `/app/data` (база данных, uploads)
- `pip_cache` → `/root/.cache/pip` (кэш pip)
- `bot_data` → `/app/data` (данные бота)

## 🔄 Обновление

**Автоматически:** При `git push` сервер обновится сам через webhook.

**Вручную:**
```bash
cd /path/to/todo-game
git pull
docker-compose up -d --build
```

## 🛠️ Troubleshooting

### База данных пуста после деплоя

Проверьте что volume подключён:
```bash
docker-compose exec web ls -la /app/data/
```

Если пусто, данные могут быть в старом месте:
```bash
docker-compose exec web ls -la /app/users.db
```

### Вебхук не работает

Проверьте логи:
```bash
docker-compose logs -f web
```

Проверьте что сервер доступен:
```bash
curl https://your-server.com/.well-known/health
```

### Сброс данных (если нужно начать заново)

```bash
docker-compose down -v  # Удалит все volumes!
docker-compose up -d --build
```
