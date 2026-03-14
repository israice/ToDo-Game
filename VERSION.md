
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
git commit -m "v0.0.62 - added task backgroud"
git push
python run.py

# DEV LOG
v0.0.52 - code refactoring
v0.0.53 - mobile design
v0.0.54 - added 5 sub tasks
v0.0.55 - added repeated tasks as data yellow border
v0.0.56 - added sync between google calendar and table tasks
v0.0.57 - added magic stick to generate 3 tasks automatecly
v0.0.58 - added new screenshot
v0.0.59 - added task settings button
v0.0.60 - js files to each global functionality
v0.0.61 - added colored sub tasks indicator in left side
v0.0.62 - added task backgroud

