# Marketplace API contract

Домашнє завдання виконане за **варіантом Б — runtime-валідація на кордоні**.
Express-застосунок використовує `express-openapi-validator` для перевірки запитів і відповідей за OpenAPI-спекою. Дані зберігаються in-memory і скидаються після перезапуску.

## Встановлення і запуск

```bash
npm install
npm start
```

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
| `DB_URL` | так | PostgreSQL URL без пароля |
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
chmod 600 secrets/db_password
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

`rotate.sh` змінює пароль ролі PostgreSQL, оновлює файл-секрет і закриває старі з'єднання. `pg.Pool` перечитує файл для кожного нового з'єднання, тому застосунок продовжує працювати, а `uptime_seconds` не обнуляється.

Після `docker compose down -v` поверніть стартовий пароль у `secrets/db_password` перед наступним запуском:

```bash
printf '%s\n' 'marketplace-local-password' > secrets/db_password
```
