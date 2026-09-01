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
