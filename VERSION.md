
# RUN
┌──────────────────────┬───────────────────────────────────┐
│ Scenario             │ Method                            │
├──────────────────────┼───────────────────────────────────┤
│ Personal use         │ python run.py                  │
│ Development          │ BACKEND/start-all.sh (logs visible) │
│ Production server    │ docker-compose up -d              │
│ Web only (no bot)    │ python run.py                  │
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
python run.py

# UPDATE
git add .
git commit -m "v0.0.76 - added reset line button to top panel"
git push
python run.py

# DEV LOG
v0.0.74 - added space between yellow line
v0.0.75 - added description
v0.0.76 - added reset line button to top panel
