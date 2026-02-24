
# RUN
┌──────────────────────┬───────────────────────────────────┐
│ Сценарий             │ Способ                            │
├──────────────────────┼───────────────────────────────────┤
│ Личное использование │ python server.py                  │
│ Разработка           │ ./start-all.sh (видны логи обоих) │
│ Production сервер    │ docker-compose up -d              │
│ Только веб без бота  │ python server.py                  │
└──────────────────────┴───────────────────────────────────┘
docker compose up -d --build


docker logs todo-game -f




# RECOVERY
git log --oneline -n 5

Copy-Item .env $env:TEMP\.env.backup
git reset --hard 80f714fc
git clean -fd
Copy-Item $env:TEMP\.env.backup .env -Force
git push origin master --force
python server.py

# UPDATE
git add .
git commit -m "v0.0.32 - server auto update test 6"
git push
python server.py

# DEV LOG
v0.0.1 - игравая база начало
v0.0.2 - обновлены задания и их поочередность
v0.0.3 - подключен webhook production auto update
v0.0.4 - auto version update in page
v0.0.5 - testing version change
v0.0.6 - testing version change test 2
v0.0.7 - смена дизайна на мобильный
v0.0.8 - deploy fix
v0.0.9 - пересобраны файлы заного для уменьшения размеров
v0.0.10 - исправлен дизайн логин страницы
v0.0.11 - исправления дизайна на странице игры
v0.0.12 - переведено на русский
v0.0.13 - добавлены скриншоты текущей версии и ссылка на сайт
v0.0.14 - добавлены табы и история достижений
v0.0.15 - добавлина соц сеть
v0.0.16 - добавлена поддержка фото и видео
v0.0.17 - server test 1
v0.0.18 - auto-refresh + telegram bot API (no browser!)
v0.0.19 - SSE real-time updates (instant sync between devices)
v0.0.20 - Telegram bot Docker support
v0.0.21 - webhook auto-deploy + all-in-one start scripts
v0.0.22 - graceful reload (zero downtime deploys)
v0.0.23 - Add SSE events for real-time task updates
v0.0.24 - gunicorn for automatic code reloading
v0.0.25 - multi-tab support with unique tab IDs for SSE connections
v0.0.26 - Modify docker-compose.yml to mount Docker socket for Telegram bot
v0.0.27 - server auto update test 1
v0.0.28 - server auto update test 2
v0.0.29 - server auto update test 3
v0.0.30 - server auto update test 4
v0.0.31 - server auto update test 5
v0.0.32 - server auto update test 6