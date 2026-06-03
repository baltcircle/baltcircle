# BaltCircle MVP — локальный запуск без VPN

Этот пакет запускает MVP велошеринга BaltCircle на вашем компьютере или сервере без домена `pplx.app`. После запуска сайт будет доступен локально по адресу:

```text
http://localhost:5000
```

## Вариант A: запуск через Docker

Это самый удобный вариант, потому что не нужно отдельно ставить Node.js и зависимости проекта.

### Что установить

1. Установите Docker Desktop:
   - macOS: https://www.docker.com/products/docker-desktop/
   - Windows: https://www.docker.com/products/docker-desktop/
   - Linux: Docker Engine + Docker Compose plugin

2. Распакуйте архив проекта.

3. Откройте терминал в папке проекта `baltcicl`.

### Команды

```bash
docker compose up --build
```

После запуска откройте:

```text
http://localhost:5000
```

Остановить:

```bash
docker compose down
```

Полностью сбросить демо-базу:

```bash
docker compose down -v
docker compose up --build
```

## Вариант B: запуск через Node.js

### Что установить

- Node.js 20 LTS или новее.

### Команды

```bash
npm install
npm run build
npm run start
```

Откройте:

```text
http://localhost:5000
```

Сбросить демо-базу:

```bash
rm -f data.db data.db-shm data.db-wal
npm run start
```

На Windows удалите эти файлы через проводник или PowerShell.

## Что внутри MVP

- стилизованная карта Балтийского побережья (Зеленоградск, Пионерский, Светлогорск) с велосипедами, станциями, зонами и велодорожками;
- QR-аренда;
- тарифы и демо-кошелёк;
- GPS-симуляция поездки;
- парк из 100 велосипедов;
- аналитика;
- сервисные заявки;
- светлая и тёмная тема.

## Важно

Это прототип. В нём нет реальной авторизации, реальных платежей, настоящего GPS и интеграции с физическими smart-lock замками. Для продакшена нужно добавить:

- SMS/OTP авторизацию;
- роли пользователей: клиент, оператор, механик, админ;
- PostgreSQL/Supabase вместо локальной SQLite;
- YooKassa/CloudPayments или другую платёжную систему;
- реальную карту MapLibre/OSM;
- мобильное приложение с камерой QR, GPS и BLE/API для замка.

## Перенос на сервер позже

Этот же Docker-пакет можно будет перенести на Yandex Cloud, Timeweb, Selectel или другой VPS. На сервере приложение обычно запускается на `localhost:5000`, а внешний доступ идёт через nginx по HTTPS.

