
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
git commit -m "v0.0.72 - added more space in task row"
git push
python run.py

# DEV LOG
v0.0.64 - server test 2
v0.0.65 - server test 3
v0.0.66 - added white circle to right menu buttton
v0.0.67 - added vertical line to tasks
v0.0.68 - update task date styles for improved readability
v0.0.69 - fixed small visual issues
v0.0.70 - fixed spacing in rows for mobile view
v0.0.71 - testing mobile version
v0.0.72 - added more space in task row
