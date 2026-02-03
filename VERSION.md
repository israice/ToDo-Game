
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
git commit -m "v0.0.13 - test 2"
git push

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
