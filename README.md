# TakeRide / BaltCircle

MVP велошеринга Балтийского побережья. Бэкенд на Node.js + PostgreSQL (managed,
например Yandex Cloud), фронтенд на React/Vite, упаковано в один Docker-образ.

Локальный запуск без домена описан в [README_LOCAL_RU.md](README_LOCAL_RU.md).
Ниже — инструкция по развёртыванию на сервере.

## Развёртывание

### 1. Подготовка переменных окружения

Скопируй пример и заполни значения:

```bash
cp .env.example .env
```

Открой `.env` и задай переменные. Все секреты (`*_PASSWORD`, токены, API-ключи)
держи только в `.env` на сервере — не коммить их в репозиторий.

> Важно про `TBANK_PASSWORD`: пароль терминала T-Bank часто содержит `$`.
> Docker Compose интерполирует `.env`, поэтому каждый `$` в пароле нужно
> экранировать как `$$` (например `TBANK_PASSWORD=$$ecret`). Подробности — в
> комментарии к переменной в `.env.example`.

### 2. Обязательные переменные

Минимум для production:

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | Строка подключения к PostgreSQL (managed Yandex Cloud или свой сервер). Без неё пул подключений не поднимется и контейнер сразу упадёт при старте (`docker compose` жёстко требует эту переменную). Формат: `postgresql://user:password@host:6432/dbname?sslmode=verify-full`. |
| `PAYMENT_TOKEN_KEY` | AES-256-GCM ключ для шифрования привязанных карт (`payment_methods`) в БД. Без него — не ошибка при старте, но сервер бросает исключение при первой попытке привязать карту. Случайная строка: `openssl rand -hex 32`. Никогда не менять на живой базе без миграции re-encryption — иначе существующие карты станут нерасшифровываемыми. |
| `SESSION_SECRET` | Секрет для подписи сессий (и хэширования OTP, если `OTP_SECRET` не задан). Случайная строка ≥32 символов: `openssl rand -hex 48`. |
| `NODE_ENV` | `production`. |
| `PORT` | Порт сервера (по умолчанию `5000`). |
| `SMS_PROVIDER` | `smsru` или `sigmasms`. Если пусто — коды OTP пишутся в лог, реальные SMS не отправляются (только для разработки). |
| `SMSRU_API_ID` | API-ключ SMS.RU (если `SMS_PROVIDER=smsru`). |
| `SIGMASMS` / `SIGMASMS_TOKEN` | Токен SigmaSMS (если `SMS_PROVIDER=sigmasms`). |
| `TBANK_TERMINAL_KEY` | Ключ терминала из кабинета T-Bank. Без него платежи отдают 503. |
| `TBANK_PASSWORD` | Пароль терминала из кабинета T-Bank (см. предупреждение про `$`). |
| `TBANK_API_BASE` | Хост эквайринга: тест `https://rest-api-test.tinkoff.ru/v2/`, прод `https://securepay.tinkoff.ru/v2/`. |
| `PUBLIC_APP_URL` | Публичный URL приложения для webhook T-Bank, например `https://yourdomain.com`. |
| `ADMIN_PHONE_NUMBERS` | Телефоны администраторов через запятую (получают роль admin при входе). |

Остальные переменные (`VITE_YANDEX_MAPS_API_KEY`, `OTP_SECRET`,
`SIGMASMS_SENDER`, `TBANK_*` тюнинг и т.д.) опциональны — см. описания в
`.env.example`.

### 3. Подготовка данных на хосте (карта и вложения)

`docker-compose.yml` монтирует на сервере два каталога, которые нужно создать
**до** первого запуска — Docker Compose тихо создаст их пустыми, если их нет,
и вместо ошибки вы получите пустую карту:

| Путь на хосте | Назначение |
|---|---|
| `/home/yc-user/osm` | PMTiles-экстракт карты (`kaliningrad.pmtiles`, ~571 МБ, Protomaps-экстракт Балтийского побережья) + `addresses.pmtiles` (OSM house numbers). Без файла `/kaliningrad.pmtiles` отдаёт 404, карта в браузере останется пустой/серой — приложение при этом не крашится. Генерируется отдельно (`tilemaker`/`scripts/build-addresses.sh`), не входит в образ и не коммитится в репозиторий из-за размера. |
| `/home/yc-user/uploads` | Вложения чата поддержки (фото от клиентов). Persistent bind mount — переживает пересборку контейнера. |

### 4. Запуск через Docker

```bash
docker compose up -d --build
```

Контейнер `baltcircle-mvp` поднимется на порту `5000` (только на loopback
`127.0.0.1`, наружу не торчит — доступ снаружи идёт через nginx). Данные
хранятся в managed PostgreSQL (`DATABASE_URL`), у контейнера больше нет своего
DB-тома. Дополнительно поднимается `LOCK_GATEWAY_PORT` (по умолчанию `5100`) —
TCP-шлюз OMNI для смарт-замков велосипедов; порт нужно так же открыть в
firewall/security group, если замки подключаются извне. Внешний HTTP-доступ
обычно проксируется через nginx по HTTPS.

Остановить:

```bash
docker compose down
```

### 5. Проверка работоспособности

```bash
# health-страница приложения должна вернуть 200
curl -I http://localhost:5000

# логи контейнера: ищем строку "serving on port 5000"
docker compose logs -f baltcircle
```

Затем открой `http://localhost:5000` (или публичный `PUBLIC_APP_URL`) в браузере —
должна загрузиться карта. Для проверки входа запроси OTP-код: при настроенном
`SMS_PROVIDER` придёт SMS, без него код будет виден в логах контейнера.
