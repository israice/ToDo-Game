# GitHub Webhook Setup for TODO GAME

## Автоматическое обновление при git push

### 🚀 Быстрое обновление без простоя

Используется **graceful reload** через сигналы:
- **Gunicorn**: `SIGHUP` — перезапускает workers без обрыва соединений
- **Telegram бот**: `SIGUSR2` — graceful restart

**Время обновления:** ~10-20 сек  
**Downtime:** ~0 секунд (запросы не теряются)

---

### 📊 Как это работает

```
git push → GitHub → Webhook → server.py
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
   git fetch origin    pip install       npm install (bot)
   git reset --hard
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                              ▼
              SIGHUP → Gunicorn (graceful reload)
              SIGUSR2 → Telegram bot (graceful restart)
```

### 🔧 Настройка

#### 1. Настройте .env

```bash
# Скопируйте пример
cp .env.example .env

# Отредактируйте .env
WEBHOOK_SECRET=your-super-secret-key-here
REPO_URL=https://github.com/YOUR_USERNAME/todo-game.git
BRANCH=master
```

**Важно:** `WEBHOOK_SECRET` должен быть сложной случайной строкой!

#### 2. Запустите сервер

```bash
# Docker (рекомендуется)
docker-compose up -d --build

# Или локально
python server.py
```

#### 3. Настройте webhook на GitHub

1. Откройте ваш репозиторий на GitHub
2. **Settings** → **Webhooks** → **Add webhook**
3. Заполните:
   - **Payload URL:** `https://your-server.com/webhook`
   - **Content type:** `application/json`
   - **Secret:** значение из `.env` (`WEBHOOK_SECRET`)
   - **Events:** Just the push event
4. Нажмите **Add webhook**

#### 4. Проверьте

Сделайте `git push` → сервер автоматически обновится!

---

### 🧪 Тестирование webhook

```bash
# Посмотрите логи
docker logs todo-game -f

# Или для локального запуска
# Смотрите вывод в консоли
```

В логах должно быть:
```
Updating Telegram bot dependencies...
```

---

### 🔍 Troubleshooting

#### Webhook не работает

1. **Проверьте логи:**
   ```bash
   docker logs todo-game
   ```

2. **Проверьте секрет:**
   - Убедитесь, что `WEBHOOK_SECRET` в `.env` совпадает с GitHub
   - Нет лишних пробелов или кавычек

3. **Проверьте URL:**
   - Payload URL должен заканчиваться на `/webhook`
   - Сервер доступен из интернета

4. **Проверьте события:**
   - В GitHub: Settings → Webhooks → Recent Deliveries
   - Должен быть статус `200 OK`

#### Telegram бот не обновляется

Убедитесь, что `telegram/package.json` существует:
```bash
ls telegram/package.json
```

---

### 🛡️ Безопасность

- Webhook подписывается через `X-Hub-Signature-256`
- Секрет хранится в `.env`, не в репозитории
- Только push события на указанный branch

---

### 📘 Альтернатива: GitHub Actions

Если webhook не работает, используйте GitHub Actions:

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [master]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SSH_KEY }}
          script: |
            cd /path/to/todo-game
            git pull
            docker-compose up -d --build
```

---

### 📚 Документация

- [GitHub Webhooks](https://docs.github.com/en/webhooks)
- [Docker Compose](https://docs.docker.com/compose/)
