# Миграция данных на сервере

После обновления от 25.02.2026 база данных и файлы перемещены в `/app/data/` для сохранения при деплое.

## Автоматическая миграция

При первом запуске новой версии данные будут перенесены автоматически.

## Ручная миграция (если нужно)

```bash
# Остановите контейнер
docker-compose down

# Создайте резервную копию
docker run --rm -v todo-game_app_data:/app/data -v $(pwd):/backup alpine tar czf /backup/data-backup.tar.gz -C /app/data .

# Запустите миграцию
docker run --rm -v todo-game_app_data:/app alpine sh -c "
  # Переместить базу данных
  [ -f /app/users.db ] && mv /app/users.db /app/data/users.db
  
  # Переместить uploads
  [ -d /app/uploads ] && mv /app/uploads /app/data/uploads
"

# Запустите контейнер
docker-compose up -d
```

## Проверка

```bash
# Проверьте что файлы на месте
docker-compose exec web ls -la /app/data/

# Проверьте базу
docker-compose exec web sqlite3 /app/data/users.db ".tables"
```
