
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
git commit -m "v0.0.33 - test 2"
git push
python server.py

# DEV LOG
v0.0.21 - webhook auto-deploy + all-in-one start scripts
v0.0.22 - graceful reload (zero downtime deploys)
v0.0.23 - Add SSE events for real-time task updates
v0.0.24 - gunicorn for automatic code reloading
v0.0.25 - multi-tab support with unique tab IDs for SSE connections
v0.0.26 - Modify docker-compose.yml to mount Docker socket for Telegram bot
v0.0.27 - websocket instead SSE
v0.0.28 - websocket tested with telegram actions
v0.0.29 - update auto-refresh logic to use WebSocket instead of SSE
v0.0.30 - track WebSocket connection state and refresh on reconnect
v0.0.31 - more ative tasks in list less paddings
v0.0.32 - test 1
v0.0.33 - test 2