
# RECOVERY
docker compose up -d --build


git log --oneline -n 20

Copy-Item .env $env:TEMP\.env.backup
git reset --hard 80f714fc
git clean -fd
Copy-Item $env:TEMP\.env.backup .env -Force
git push origin master --force

# UPDATE
git add .
git commit -m "v0.0.4 - auto version update in page"
git push

# DEV LOG
v0.0.1 - игравая база начало
v0.0.2 - обновлены задания и их поочередность
v0.0.3 - подключен webhook production auto update
v0.0.4 - auto version update in page
