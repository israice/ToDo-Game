
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
git commit -m "v0.0.55 - added repeated tasks as data yellow border"
git push
python run.py

# DEV LOG
v0.0.40 - server test 6
v0.0.41 - improved documentation behavior
v0.0.42 - improved configuration loading
v0.0.43 - version update test 1
v0.0.44 - changed to english version
v0.0.45 - added data of start and deadline
v0.0.46 - added google calendar support
v0.0.47 - Picker Wheel for table
v0.0.48 - Fullscreen drum roller
v0.0.49 - added keyboard swiping pages right and left
v0.0.50 - new screenshots
v0.0.51 - added enddless keyboard totation of tabs
v0.0.52 - code refactoring
v0.0.53 - mobile design
v0.0.54 - added 5 sub tasks
v0.0.55 - added repeated tasks as data yellow border
