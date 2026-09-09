# Marketplace API contract

Домашнє завдання виконане за **варіантом Б — runtime-валідація на кордоні**.
Express-застосунок використовує `express-openapi-validator` для перевірки запитів і відповідей за OpenAPI-спекою. Дані зберігаються in-memory і скидаються після перезапуску.

## Встановлення і запуск

```bash
npm install
```

Перед запуском підготуйте конфігурацію та файл-секрет за інструкцією [Configuration](#configuration). Без обов'язкового `DB_URL` застосунок завершується з помилкою.

Сервер працює на `http://localhost:3000` (порт можна змінити змінною `PORT`).

## Перевірки

```bash
npm run lint:api
npm run bundle:api
npm test
```

Ручна перевірка контракту:

```bash
# Спека вимагає заголовок — 400 application/problem+json
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"product_id":"prod-1","quantity":1}]}'

# Порожній масив заборонений схемою — 400 application/problem+json
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"items":[]}'

# Валідне створення — 201
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"items":[{"product_id":"prod-1","quantity":2}]}'
```

Повтор того самого ключа з тим самим тілом повертає ту саму відповідь `201` і `Idempotency-Replay: true`. Повтор ключа з іншим тілом повертає `422 application/problem+json`.

## Configuration

Конфігурація проходить через одну Zod-схему в `src/config/env.schema.ts` і завантажується `ConfigModule.forRoot`. Некоректна або відсутня обов'язкова змінна зупиняє процес до створення сервера. Приклад усіх змінних зберігається в `.env.example`; реальний `.env` і `secrets/` ігноруються Git та Docker.

| Змінна | Обов'язковість | Призначення |
| --- | --- | --- |
| `NODE_ENV` | ні, `development` | Режим виконання |
| `PORT` | ні, `3000` | HTTP-порт, ціле число 1–65535 |
| `DB_URL` | так | PostgreSQL URL без пароля. Джерело — конфігураційне сховище ДЗ №11: локальний ігнорований `.env`; у Compose — runtime environment сервісу app (`postgresql://marketplace@db:5432/marketplace`). Для prod — те саме ім'я у конфігурації розгортання, пароль із файла-секрета. |
| `DB_PASSWORD_FILE` | ні, `/run/secrets/db_password` | Шлях до файла з паролем БД |
| `DB_POOL_MAX` | ні, `10` | Максимальний розмір пулу з'єднань |

Перевірка синхронності контракту конфігурації:

```bash
npm run check:env
```

Fail-fast можна перевірити без локального `.env`:

```bash
mv .env /tmp/marketplace.env
env -u DB_URL npm run start
echo $?
mv /tmp/marketplace.env .env
```

Команда завершується з ненульовим кодом і повідомленням, яке містить `DB_URL`.

### Запуск із PostgreSQL

Створіть локальні файли з прикладів, якщо їх ще немає:

```bash
cp .env.example .env
mkdir -p secrets
printf '%s\n' 'marketplace-local-password' > secrets/db_password
chmod 700 secrets
chmod 644 secrets/db_password
docker compose up --build -d
```

Перевірка процесу та підключення до БД:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/db-health
```

### Ротація пароля без рестарту

```bash
curl http://localhost:3000/health
bash rotate.sh
curl http://localhost:3000/db-health
curl http://localhost:3000/health
```

`rotate.sh` бере роль і назву БД з `DB_URL` сервісу `app` у результаті `docker compose config --format json` (включно з overrides). Для запуску скрипта потрібні Node.js, OpenSSL і Docker Compose. Скрипт змінює пароль ролі PostgreSQL, оновлює файл-секрет і закриває старі з'єднання. `pg.Pool` перечитує файл для кожного нового з'єднання, тому застосунок продовжує працювати, а `uptime_seconds` не обнуляється.

Runtime-образ містить лише production-залежності, `dist`, OpenAPI та `.env.example`; процес працює як `node`. Compose монтує файл-секрет із хоста: режим `644` дозволяє читати його користувачу контейнера, а каталог `secrets` із режимом `700` закриває доступ іншим користувачам хоста. Під час ротації файл оновлюється на місці, щоб bind mount бачив новий вміст.

Після `docker compose down -v` поверніть стартовий пароль у `secrets/db_password` перед наступним запуском:

```bash
printf '%s\n' 'marketplace-local-password' > secrets/db_password
```

## HW-12: дата-шар та оптимізація

Після клонування гілки `hw-12` перейдіть у `marketplace/` (проєкт знаходиться
в підкаталозі репозиторію). Потрібен запущений Docker із Compose; локальні Node.js,
psql та `.env` для SQL-стенда не потрібні. Головна таблиця — `orders` (200 000 рядків).
User stories і рішення: [ADR-001](db/ADR-001.md).

Підняти базу (один рядок, працює на свіжому клоні):

```bash
sh scripts/db-up.sh
```

Підключитись і перевірити доступ (один рядок, очікується `1`):

```bash
docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U marketplace -d marketplace -Atc 'SELECT 1'
```

Скрипт створює відсутній secret із `db/db_password.example`; наявний пароль не
перезаписує. Postgres ініціалізується цим самим файлом. Нових env-файлів у git немає.
DB_URL застосунку вказує на цю саму БД `marketplace` у Compose; у prod значення
задається у середовищі розгортання через існуючу Zod-схему.

Повний цикл на чистому volume (перша команда видаляє локальні дані цього Compose-проєкту):

```bash
docker compose down -v
sh scripts/db-up.sh
docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U marketplace -d marketplace < db/schema.sql
docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U marketplace -d marketplace < db/seed.sql
docker compose exec -T db psql -X -U marketplace -d marketplace -Atc "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='public'; SELECT count(*) FROM orders;"
for n in 1 2 3; do docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U marketplace -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$n.sql)"; done
docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U marketplace -d marketplace < db/indexes.sql
docker compose exec -T db psql -X -U marketplace -d marketplace -c 'ANALYZE;'
for n in 1 2 3; do docker compose exec -T db psql -X -v ON_ERROR_STOP=1 -U marketplace -d marketplace -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$n.sql)"; done
docker compose exec -T db psql -X -U marketplace -d marketplace -c 'SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE idx_scan = 0;'
```

Очікується 4 FK; кожен план до індексів містить Seq Scan, після — індексний вузол
без Seq Scan. `indexes.sql` додає один covering, один partial та один expression індекс.
Фактичні плани й час виконання: [OPTIMIZATIONS](db/OPTIMIZATIONS.md).
Схема й seed застосовуються один раз до порожньої БД; seed закінчується `VACUUM (ANALYZE)`.
Існуючі HTTP-обробники залишаються in-memory; `/db-health` перевіряє реальну БД.
