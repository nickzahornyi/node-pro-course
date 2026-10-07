# Marketplace API contract

Для поточного ДЗ **HW-18 (WebSocket / SSE)** починайте з [Realtime](#realtime-hw-18).
Усі npm/Compose-команди виконуються в `marketplace/` після клонування репозиторію.
Розділ HW-12 нижче збережено як окремий SQL-стенд попереднього завдання.

Домашнє завдання виконане за **варіантом Б — runtime-валідація на кордоні**.
Nest-застосунок використовує `express-openapi-validator` для перевірки запитів і відповідей за `openapi/openapi.yaml`. Товари, замовлення та ключі ідемпотентності зберігаються в PostgreSQL. Старий `src/app.ts` залишено лише для історичних unit-тестів; production entrypoint — `src/main.ts` → `AppModule`.

Публічний POST `/orders` створює draft: початковий контракт не містить покупця чи оплати, тому використовується технічний гостьовий користувач, без списання балансу й запасів. Транзакційний оплачуваний checkout із HW-14 залишається окремим сценарієм `src/checkout.ts`. ID товару беріть із GET `/products` (після seed, наприклад, `1`).

## Realtime HW-18

Команди виконуються з `marketplace/` у гілці `hw-18`; потрібні Node.js 22+ та Docker Desktop. Підніміть окремий стенд із чистими volumes, щоб seed-користувачі 1 і 2 володіли відповідно замовленнями 1 і 2. На вже заповненій БД ID можуть відрізнятися: задайте `REALTIME_ORDER_A/B` і `REALTIME_USER_A/B` за фактичними `orders.id/user_id`.

```bash
cd marketplace
npm ci && npx tsc --noEmit
export COMPOSE_PROJECT_NAME=marketplace-hw18
docker compose up -d --build --wait app
curl --fail http://localhost:3000/db-health
```

Compose виконує міграції та seed, а `credentials` генерує випадковий HMAC-ключ `realtime_auth_secret` один раз у named volume. Ключ змонтований read-only в API й зберігається після рестарту. Для локального процесу використовуйте `.env.example` → `.env`, власний `AUTH_SECRET` (32+ символи) або `AUTH_SECRET_FILE`, `npm run build && node dist/main.js`; у dev-режимі `npm run build:watch` компілює зміни через tsc, а `npm run start:dev` в іншому терміналі запускає Node зі спостереженням за `dist`.

Повноцінний login ще поза межами цього ДЗ: токени видає оператор через CLI всередині контейнера, після перевірки існування користувача. Публічного endpoint для їх видачі немає. Формат токена — підписаний HMAC-SHA256 identity payload (`sub`, `aud`, `exp`), строк дії одна година; API перевіряє підпис та строк, а потім звіряє `orders.user_id`. Самого `user_id` у заголовку чи join-повідомленні недостатньо для доступу. Для production ключ надходить із secret-ресурсу або сховища, а identity потрібно інтегрувати з login/IdP.

```bash
export TOKEN_A="$(docker compose exec -T app node dist/realtime/issue-token.js 1)"
export TOKEN_B="$(docker compose exec -T app node dist/realtime/issue-token.js 2)"
```

HTTP-потоки потребують `Authorization: Bearer <token>`; Socket.IO — `auth: { token }`. Анонімний отримує 401 / `connect_error: Unauthorized`; власник іншого замовлення — 403 / join-ack `{ok:false,status:403}`. Токени не передаються у query string. Після закінчення строку дії відкриті WS/SSE-з'єднання закриваються; для продовження потрібен новий токен.

### Події та зміна статусу

```bash
# Термінал 1: потік майбутніх подій (потрібен експорт TOKEN_A у цьому терміналі)
curl -sN --max-time 30 -H "Authorization: Bearer $TOKEN_A" \
  http://localhost:3000/orders/1/events

# Термінал 2: зміна через HTTP, після якої подія з'явиться в терміналі 1
curl --fail-with-body -X PATCH http://localhost:3000/orders/1/status \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"status":"paid"}'
```

`PATCH /orders/:id/status` викликає `OrderStatusService`: транзакція з `SELECT … FOR UPDATE` перевіряє власника й оновлює статус. Лише після COMMIT сервіс публікує одну подію в `OrderEventsService`; незмінний статус та rollback не створюють події. Операції commit→publish впорядковані для одного замовлення в одному процесі. Це навчальна зміна статусу, а не платіжна операція чи повернення грошей; вона дозволяє повторні переходи між `pending`, `paid`, `shipped`, `cancelled`. GET повертає актуальний статус; тільки `pending` зберігає початкову публічну назву `created`.

Gateway слухає ту саму шину й виконує `server.to('orders:<id>').emit('order.status', event)`. Join підтримує `{order_id:'1'}` або рядок `'1'`; ack `{ok:true,room:'orders:1'}` надходить після перевірки власника та входу в кімнату. SSE фільтрує ту саму подію за order_id:

```text
retry: 1000

id: 1
event: order.status
data: {"order_id":"1","previous_status":"pending","status":"paid","id":1,"occurred_at":"2026-10-07T10:00:00.000Z"}
```

SSE встановлює `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, heartbeat кожні 15 секунд. ID глобально зростає в межах одного процесу; на реконекті `Last-Event-ID` повертає лише події цього замовлення з більшими ID, потім потік продовжується наживо. Зберігаються останні 500 подій: застарілий cursor повертає 410, cursor попереду поточної історії — 400. Після рестарту буфер та нумерація починаються заново, тому слід перечитати стан і підписатися без cursor; довговічне відновлення потребує persistent event log/outbox.

### Перевірки грейдера

```bash
# Заголовок (curl завершує нескінченний потік через таймаут, exit 28 очікуваний)
curl -sN --max-time 2 -D - -o /dev/null \
  -H "Authorization: Bearer $TOKEN_A" http://localhost:3000/orders/1/events

# Щонайменше чотири реальні зміни за будь-якого початкового статусу
# (лише перший PATCH може виявитися no-op)
for status in pending paid shipped pending cancelled; do
  curl --fail-with-body -s -X PATCH http://localhost:3000/orders/1/status \
    -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
    -d "{\"status\":\"$status\"}"
done

# На чистому процесі перший пропущений id > 3 (за наведеним порядком — 4)
curl -sN --max-time 2 -H "Authorization: Bearer $TOKEN_A" \
  -H 'Last-Event-ID: 3' http://localhost:3000/orders/1/events

node scripts/realtime-demo.mjs
# A_RECEIVED=1 / B_RECEIVED=0 / exit 0
node scripts/realtime-demo.mjs --same-room
# A_RECEIVED=1 / B_RECEIVED=1 / exit 0

npm run test:realtime
npm run test:e2e
npm test
```

Демо саме отримує токени користувачів через CLI поточного Compose-стенда, підключає два незалежні клієнти, чекає join-ack, виконує PATCH і рахує лише отримані події з повернутим `event_id`. У `--same-room` другий сокет використовує identity власника A, щоб обидва входи були дозволені. Скрипт має обмежені таймаути й сам закриває сокети; неправильні counts або HTTP/join-помилка дають exit 1. Для API поза Compose задайте `REALTIME_URL`, `REALTIME_ORDER_A/B`, `REALTIME_TOKEN_A/B`; секрет підпису клієнтам не потрібен.

`test/e2e/realtime.spec.js` працює на PostgreSQL 16 у testcontainer та повному AppModule: обидва прогони реального demo, auth/ownership, ідентичний payload у двох транспортів, replay без дублів, rollback/no-op та конкурентний порядок. Unit-тести перевіряють підробку/прострочення токена і межі буфера. HTTP-контракт нових маршрутів та SSE payload описані в `openapi/openapi.yaml`.

Перевірено 2026-10-07: `npm ci` та `tsc --noEmit` — exit 0; realtime 7/7 (повний E2E 11/11), integration 8/8, unit 35/35, Pact consumer 1/1 та provider verification OK. Docker-стенд пройшов обидва demo: `A_RECEIVED=1/B_RECEIVED=0` і `A_RECEIVED=1/B_RECEIVED=1`, обидва exit 0. Реальний curl показав `Content-Type: text/event-stream; charset=utf-8`, live frame з `id: 7`, `event: order.status`, JSON `status: pending`; після `Last-Event-ID: 3` — ID `4,5,6,7` без дублів. Таблиця trade-offs проходить awk-перевірку (1 роздільник, 7 рядків із `|`), workflow — `actionlint` exit 0.

## Trade-offs: WebSocket vs SSE

| Критерій | WebSocket / Socket.IO | SSE |
| --- | --- | --- |
| Напрям каналу | Двосторонній: клієнт надсилає join та інші повідомлення, сервер пушить події. | Сервер → клієнт; зміна статусу виконується звичайним HTTP PATCH. |
| Реконект / відновлення | Socket.IO реконектиться, але потрібно повторити join; у цьому ДЗ WS не має replay. | EventSource реконектиться та передає Last-Event-ID; наш буфер відновлює пропущені події. |
| Інфраструктура | Проксі має підтримувати HTTP Upgrade; rooms/адаптер потрібно узгоджувати між інстансами. | Звичайний довгий HTTP-response; потрібно вимкнути proxy buffering та налаштувати idle timeout. HTTP/2 зменшує обмеження кількості з'єднань. |
| Ціна на подію | Невеликий бінарний framing WebSocket, додатковий Socket.IO envelope; одне постійне з'єднання. | Текстові поля id/event/data на кожну подію; одне постійне з'єднання, без нового HTTP-запиту на кожен статус. |
| Авторизація браузера | Socket.IO передає token у handshake auth. | Нативний EventSource не має довільних Authorization headers: для продакшну потрібні HttpOnly cookie або fetch-based SSE, як у наших тестах. |

Для односторонніх нотифікацій статусу я залишив би SSE: клієнт змінює дані через HTTP, а сервер передає події з простим cursor-відновленням. WebSocket виправданий, коли з'являться двосторонні команди або інтенсивний обмін. При двох інстансах локальні rooms і SSE-буфери розходяться: Socket.IO Redis adapter поширює WS-події, спільний pub/sub живить SSE на кожному інстансі, а durable event log/outbox із глобальними ID потрібний для replay та захисту від втрати між commit і publish.

Джерела: [Nest gateways](https://docs.nestjs.com/websockets/gateways), [SSE формат та Last-Event-ID](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

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
  -d '{"items":[{"product_id":"1","quantity":2}]}'
```

Повтор того самого ключа з тим самим тілом повертає ту саму відповідь `201` і `Idempotency-Replay: true`. Повтор ключа з іншим тілом повертає `422 application/problem+json`.

## Тестування HW-16

Потрібні Node.js 22+, запущений Docker; усі команди — з `marketplace/`:

```bash
npm ci && npx tsc --noEmit
npm run test:integration && npm run test:integration
npm run test:e2e
npm run test:contract
npm run verify:provider
```

Перевірено 2026-10-01: integration **8/8 двічі**, E2E **4/4**, consumer **1/1**, provider **has a matching body (OK)**. Jest має `reporters: ['default']`, `maxWorkers: 1`, `watchman: false`; TypeScript компілюється через `tsc` зі справжніми decorator metadata.

Ізоляція: кожен suite створює власний `PostgreSqlContainer('postgres:16-alpine')`, запускає реальні міграції й закриває пул та контейнер. Репозиторії приймають об'єкт із `query()`, тому кожний integration-кейс працює через один Client у BEGIN/ROLLBACK; E2E використовує TRUNCATE між кейсами, бо HTTP-запити мають власні транзакції. UUID-дефолти builders `aUser()` / `aProduct()` усувають конфлікти даних, повторний запуск не потребує очищення вручну.

Покрито ProductsRepository і OrdersRepository (по 4 кейси), FK `23503`, case-insensitive UNIQUE `23505`, JOIN та SUM. E2E створює повний `Test.createTestingModule({ imports: [AppModule] })` без overrides: створення → читання після рестарту застосунку, 404, 400, конкурентний replay та 422. `configureApp()` спільний із production; DB_URL і DB_PASSWORD беруться з URI контейнера до імпорту AppModule, `.env` у тестах не читається.

Consumer `MarketplaceWeb` запитує GET `/products/7` у `MarketplaceAPI`, provider state — `a product with ID 7 exists`. Шлях і JSON-відповідь автоматично звіряються з `openapi/openapi.yaml`; provider stateHandler засіває справжню БД через INSERT ON CONFLICT, а verifier звертається до реального Nest HTTP-сервера. `pacts/*.json` ігноруються Git: `test:contract` генерує їх локально й у CI перед verification.

### Broker і локальний can-i-deploy

Штатний режим цього навчального стенда й CI — `SKIP_VAULT=1`: конфігурація надходить через environment, а `bash scripts/with-secrets.sh dev npm run verify:provider` запускає команду з цими значеннями. Infisical-проєкт ще не налаштовано, тому отримання секретів зі сховища не перевірялося. Для підключення HW-11 збережіть `PACT_BROKER_URL` та `PACT_BROKER_TOKEN` у dev/prod сховищі й приберіть `SKIP_VAULT=1`; та сама обгортка тоді викликає `infisical run`. Це зберігає передбачений завданням шлях через сховище для звичайного запуску з реальними секретами.

Для демонстрації unknown потрібен новий брокер без попереднього prod-тега. Виберіть окремий, ще не використаний COMPOSE_PROJECT_NAME; не видаляйте volumes із потрібними даними. Порти 5432, 6432, 3000 та 9292 мають бути вільними (за потреби змініть `*_PUBLISHED_PORT`).

```bash
export COMPOSE_PROJECT_NAME=marketplace-hw16-demo
docker compose up -d --wait
export PACT_BROKER_URL=http://127.0.0.1:9292
export CONSUMER_VERSION=hw16-20261001 PROVIDER_VERSION=hw16-20261001
export SKIP_VAULT=1
npm run test:contract
curl --fail-with-body -i -X PUT \
  "$PACT_BROKER_URL/pacts/provider/MarketplaceAPI/consumer/MarketplaceWeb/version/$CONSUMER_VERSION" \
  -H 'Content-Type: application/json' \
  --data-binary @pacts/MarketplaceWeb-MarketplaceAPI.json
# HTTP 201; еквівалент із підтримкою env-токена: npm run pact:publish
bash scripts/with-secrets.sh dev npm run verify:provider
# publishVerificationResult: true; providerVersion = PROVIDER_VERSION
npm run pact:can-i-deploy
# очікуваний exit 1: deployable null, unknown 1
curl --fail-with-body -i -X PUT \
  "$PACT_BROKER_URL/pacticipants/MarketplaceAPI/versions/$PROVIDER_VERSION/tags/prod" \
  -H 'Content-Type: application/json' --data '{}'
# HTTP 201; еквівалент: npm run pact:tag-prod
curl --fail-with-body \
  "$PACT_BROKER_URL/can-i-deploy?pacticipant=MarketplaceWeb&version=$CONSUMER_VERSION&to=prod"
npm run pact:can-i-deploy
# exit 0 лише коли summary.deployable === true
```

Реальний локальний прогін 2026-10-01 (`marketplace-hw16-contract`, порт 59292): publish → HTTP 201, verification → exit 0, results published. До prod-тега, exit 1:

```json
{"summary":{"deployable":null,"reason":"There is no verified pact between version hw16-20261001 of MarketplaceWeb and the latest version of MarketplaceAPI with tag prod (no such version exists)","success":0,"failed":0,"unknown":1}}
```

Тег провайдера → HTTP 201; після тега, exit 0:

```json
{"summary":{"deployable":true,"reason":"All required verification results are published and successful","success":1,"failed":0,"unknown":0}}
```

Без `PACT_BROKER_URL` verifier перевіряє локальний згенерований pact без публікації. З URL — читає контракт із брокера та публікує результат. Токен читається лише з `process.env.PACT_BROKER_TOKEN`; локальний compose-брокер без автентифікації слухає тільки loopback і не призначений для публічного розгортання.

### CI та здача

`../.github/workflows/contracts.yml` містить jobs `tests` і `contract`. Job `contract` піднімає PostgreSQL та Pact Broker через `services`, виконує consumer → publish → verify із `publishVerificationResult: true` → `can-i-deploy`. Без GitHub secrets використовується тимчасовий брокер runner-а на 127.0.0.1:9292: спочатку гейт має відмовити, потім Compose розгортає API, перевіряються `/db-health` і `/products/7`, і лише після цього тегується розгорнутий PROVIDER_VERSION та перевіряється позитивний гейт. `prod` тут — демонстраційний тег ізольованого CI-брокера; цей запуск не є деплоєм у зовнішній production. Тимчасовий deployment очищається через `always()`.

Для постійного зовнішнього брокера задайте GitHub secrets `PACT_BROKER_URL` та `PACT_BROKER_TOKEN`. Тоді CI публікує й перевіряє контракт у ньому, а локальні deploy/tag кроки пропускає: `prod` позначає версію, яку ваш production deployment вже успішно розгорнув. Після успішного зовнішнього деплою та healthcheck виконайте `PROVIDER_VERSION=<SHA розгорнутої версії> npm run pact:tag-prod` з URL і токеном цього брокера; без перевіреної сумісності гейт лишається червоним.

Локальний еквівалент перевірено; віддалений GitHub Actions ще потрібно запустити після push. Навчальний CI більше не потребує облікових даних брокера; зовнішній брокер і Infisical потребують ваших налаштувань. Зміни підготовлено у гілці `hw-16`; commit/push/PR потрібно зробити перед здачею посилання в LMS.

Повторна перевірка 2026-10-07: `actionlint` — exit 0; окремий Compose-стенд `marketplace-hw16-review-20261007`, брокер :59412, версія `hw16-review-20261007`: consumer 1/1, publish 201, verification через `SKIP_VAULT=1` — exit 0 з публікацією результату; до тега `deployable: null, unknown: 1` і exit 1. API `/db-health` та `/products/7` — HTTP 200; tag-prod 201; після тега `deployable: true, unknown: 0` і exit 0.

## Configuration

Конфігурація проходить через одну Zod-схему в `src/config/env.schema.ts` і завантажується `ConfigModule.forRoot`. Некоректна або відсутня обов'язкова змінна зупиняє процес до створення сервера. Приклад усіх змінних зберігається в `.env.example`; реальний `.env` і `secrets/` ігноруються Git та Docker.

| Змінна | Обов'язковість | Призначення |
| --- | --- | --- |
| `NODE_ENV` | ні, `development` | Режим виконання |
| `PORT` | ні, `3000` | HTTP-порт, ціле число 1–65535 |
| `DB_URL` | так | PostgreSQL URL без пароля. Сховище Infisical dev/prod → process.env або CI environment; локально `.env` / runtime environment Compose. У тестах URI видає testcontainer. |
| `DB_PASSWORD` | ні | Пароль зі сховища Infisical або CI; якщо відсутній, ORM та HTTP-пул перечитують `DB_PASSWORD_FILE` на кожне нове з'єднання. |
| `DB_PASSWORD_FILE` | ні, `/run/secrets/db_password` | Шлях до файла з паролем БД |
| `AUTH_SECRET_FILE` | ні, `/run/secrets/realtime_auth_secret` | Файл ключа підпису realtime identity; Compose генерує випадковий ключ у credentials volume |
| `AUTH_SECRET` | ні | Env-override ключа підпису, мінімум 32 символи; випадковий у тестах, зі сховища у production |
| `DB_POOL_MAX` | ні, `10` | Максимальний розмір пулу з'єднань |
| `NPLUS1_SIZES` | ні, `5,10` | Щонайменше два різні розміри вибірки, цілі числа 1–10000 через кому |

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

Запуск із чистого клону (потрібні Node.js та Docker Desktop):

```bash
npm run api:up
```

Починаючи з HW-15, сервіс `credentials` створює відсутній пароль у named volume
із публічного dev-прикладу, але не перезаписує наявний після ротації. Той самий
ресурс читають Postgres, PgBouncer, bootstrap та API. `.env` і ручний secret не потрібні.

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

Runtime-образ містить production-залежності, `dist`, OpenAPI та `.env.example`;
процес працює як `node`. PostgreSQL-клієнт є лише в окремому target `ops`.
У HW-15 секрет зберігається в `db_credentials` volume, змонтованому read-only в API
та PgBouncer. Ротація оновлює пароль і runtime userlist, надсилає SIGHUP пулеру,
не перезапускаючи API. Файли `644` потрібні різним UID усередині контейнерів;
доступ до Docker/volume є привілейованим. Реальні секрети до репозиторію не потрапляють.
Не видаляйте `db_credentials` окремо від `postgres_data`: збережений пароль має
відповідати ролі БД. `docker compose down -v` видаляє обидва volumes і всі дані;
на наступному старті credentials автоматично повертаються до dev-прикладу.

## Grading

`cd marketplace` — перша команда після клону репозиторію; усі команди нижче виконуються в цьому каталозі з `package.json`.

Для поточного завдання виконайте [Realtime HW-18](#realtime-hw-18), для попереднього — [Тестування HW-16](#тестування-hw-16). GitHub workflow знаходиться у корені Git-репозиторію: `../.github/workflows/contracts.yml`, із `working-directory: marketplace`. Наступні інструкції збережені для регресії попередніх ДЗ.

Потрібні Node.js 22+ і Docker Compose з підтримкою `--wait`.
Після клону перейдіть у каталог сервісу: `cd marketplace`.
Використовуйте чистий volume: **не запускайте db/schema.sql або db/seed.sql HW-12
перед ORM-міграцією**. Для ізоляції від попередніх ДЗ можна задати
`export COMPOSE_PROJECT_NAME=marketplace-hw15` перед командами нижче.
Порти 5432 (Postgres, лише діагностика), 6432 (PgBouncer), 3000 (API) мають бути
вільними. Overrides: `DB_PUBLISHED_PORT`, `PGBOUNCER_PUBLISHED_PORT`, `APP_PUBLISHED_PORT`.
Порт у `DB_URL` має відповідати `PGBOUNCER_PUBLISHED_PORT`, не прямому Postgres.

Мінімальний HW-15 шлях (Node.js 22+, Docker; локальні psql/pg_dump/npm ci не потрібні):

```bash
export DB_URL=postgresql://marketplace@127.0.0.1:6432/marketplace DB_PASSWORD=marketplace-local-password
export SKIP_VAULT=1    # у грейдера немає доступу до сховища
docker compose up -d --wait
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

Compose збирає образи, створює dev-секрет, чекає PgBouncer, виконує всі міграції
та ідемпотентний seed через одноразовий `bootstrap`, потім запускає API.
Скрипти самі не викликають сховище: голий `bash scripts/backup.sh` / `restore-drill.sh`
після export також працює. Restore офлайн: бере останній завершений локальний дамп,
а не поточний стан source DB. Основний шлях — обгортка Infisical вище.

Повний regression-прогін попередніх ДЗ:

```bash
npm ci && npx tsc --noEmit
docker compose up -d --wait
export DB_URL=postgresql://marketplace@127.0.0.1:6432/marketplace DB_PASSWORD=marketplace-local-password
export SKIP_VAULT=1    # у грейдера немає доступу до сховища
npm run build
npm run migrate
npm run migrate:show
npm run check:indexes
npm run migrate:revert
npm run migrate
npm run seed && npm run seed
docker compose exec -T db psql -X -U marketplace -d marketplace -c 'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_items) AS order_items;'
npm run demo:nplus1
npm run report
npm run check:env
npm run demo:race
npm run demo:workers
npm run demo:retry
npm test
npm run test:concurrency
```

Очікуються `[X] InitialMarketplace…`, `[X] CheckoutQueue…` і `[X] ObservableJobProcessing…`, а після обох seed — `10 users`, `10 products`,
`10 orders`, `20 order_items`. `migrate:revert` відкочує останню міграцію:
спочатку видаляє `order_requests` (HW-16), наступний повертає старий CHECK `processed = 1`, наступний revert видаляє jobs і balance_cents,
ще один — таблиці HW-13. Якщо є `processed > 1`, перший revert відмовить без втрати
діагностичних лічильників; такі записи потрібно спочатку дослідити.
Виконуйте revert лише на тестовій БД: дані відкочених структур буде втрачено.
Грейдер не потребує `.env`, `.secrets/`, CLI Infisical або ручного створення secret.
База використовує публічний dev-пароль із `db/db_password.example`, змонтований
у Postgres як `POSTGRES_PASSWORD_FILE`. Усі мережеві підключення все одно проходять
парольну автентифікацію. API і ORM підключаються через PgBouncer.

## Data layer ops

Конфіг у `pgbouncer/pgbouncer.ini`: transaction mode, 5 backend connections на
пару user/database, до 200 клієнтів, admin user `marketplace`. У dev це та сама роль,
що й застосунок; production потребує окремих least-privilege ролей і захищеної мережі.
Порт 6432 опублікований лише на loopback. У `.env.example` URL указує на PgBouncer.
У **Infisical dev і prod потрібно оновити існуючий `DB_URL`** на endpoint пулера
(dev host-процеси: `127.0.0.1:6432`, Compose: `pgbouncer:6432`; prod — реальний DNS
пулера). Пароль той самий, нових env-файлів немає. Live сховище недоступне в цьому
середовищі, тому його значення автоматично не змінювалися.

Transaction mode повертає backend connection у пул після COMMIT/ROLLBACK і дозволяє
50 клієнтам race ділити 5 з'єднань. За межами однієї транзакції не можна покладатися
на session `SET`, `LISTEN`, session advisory locks або тимчасові таблиці зі збереженням
рядків між транзакціями. Використовуйте `SET LOCAL`, transaction advisory locks та
окремий session/direct endpoint для session-залежних задач. SQL `PREPARE/EXECUTE`
не стає безпечним від transaction pooling; protocol-level named statements підтримує
`max_prepared_statements=200` у PgBouncer 1.25.2. Наш pg/TypeORM не задає query `name`.
Неактивний `server_reset_query = DISCARD ALL` прибрано; `server_reset_query_always`
не вмикається. Конфіг не обіцяє очищення session-state між транзакціями.
Джерела: [режими й обмеження](https://www.pgbouncer.org/features.html),
[конфігурація](https://www.pgbouncer.org/config.html).

Перевірка з хоста, якщо встановлений psql:

```bash
PGPASSWORD=marketplace-local-password psql -h 127.0.0.1 -p 6432 -U marketplace -d marketplace -c 'SELECT 1'
PGPASSWORD=marketplace-local-password psql -h 127.0.0.1 -p 6432 -U marketplace -d pgbouncer -c 'SHOW POOLS'
```

Без локального psql: `docker compose exec pgbouncer sh -c 'PGPASSWORD=$(cat /run/secrets/db_password) psql -h 127.0.0.1 -p 6432 -U marketplace -d pgbouncer -c "SHOW POOLS"'`.

Backup: команда з Grading друкує абсолютний шлях до датованого `.dump` у `backups/`
на хості (gitignored). Змінити destination можна через `BACKUP_DIR=/absolute/path`.

Backup підтримує як URL пулера, так і прямий Postgres: наприклад,
`DB_URL=postgresql://marketplace@127.0.0.1:5432/marketplace bash scripts/backup.sh`.
Для нестандартних портів використовуються `PGBOUNCER_PUBLISHED_PORT` і
`DB_PUBLISHED_PORT` із Compose; застосунок продовжує працювати через пулер.

Retention запускається лише після успішного backup: `BACKUP_RETENTION_DAYS=7`
за замовчуванням (додатне ціле, можна змінити через environment/сховище).
Завершені bundle старші за N днів за manifest.createdAt видаляються безповоротно;
найновіший та щойно створений зберігаються завжди. `.partial-*`, symlinks,
невалідні/неповні bundle та сторонні каталоги не видаляються. Список видалених
імен друкується в stderr (у cron — backup.log). Невдалий backup нічого не прибирає.
Retention не замінює моніторинг диска: неповні артефакти потребують ручного огляду.

Ops-образ містить pg_dump/pg_restore 17. `pg_dump -Fc --snapshot=...` використовує
snapshot, утримуваний окремою READ ONLY REPEATABLE READ транзакцією; з нього ж
читаються контрольні count і sum. Тому concurrent checkout не дає хибного mismatch.
Поруч лежить manifest із контрольними значеннями, розміром і SHA-256. Незавершені
бекапи лишаються прихованими `.partial-*` та не потрапляють у drill; звичайна помилка
прибирає staging. Дамп проходить `pg_restore --list` перед публікацією.
Джерело механіки snapshot: [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).

Restore-drill вибирає останній bundle за UTC-часом і перевіряє checksum **до** запуску
Postgres. Далі створює унікальний container і новий volume, перевіряє порожню public
schema, виконує `pg_restore --no-owner --no-acl --single-transaction --exit-on-error`,
порівнює counts усіх п'яти доменних таблиць і суми orders.total_cents, users.balance_cents,
products.stock. Друкує MATCH лише при рівності; помилки дають exit != 0.
Контейнер має `--network none`, без опублікованих портів; trust застосовується лише
до цього ізольованого disposable Postgres. У finally видаляються лише створені ним
container/volume; source DB і backup ніколи не видаляються. SIGINT/SIGTERM теж
запускають cleanup (SIGKILL/збій Docker потребує ручного прибирання ресурсів з label
`marketplace.restore-drill=true` для volume). JSON-протокол зберігається біля дампу.

`npm run test:ops` (після `npm ci`, зі змінними Grading) перевіряє backup, два drill,
навмисний mismatch, зіпсований checksum і відсутність залишених drill-volumes.
Поточний ops-runner призначений для локального Compose і не приймає query-параметри
URL; production TLS/certificate mounts потрібно налаштувати окремо, а не вважати
перевіреними цим локальним drill.

`backup.cron`: щодня о 02:00 у timezone cron-хоста. Перед встановленням замініть
шлях `/absolute/path/marketplace`, задайте PATH для node/docker/infisical і machine
identity Infisical для користувача cron. Файл не встановлює cron автоматично.
Розрахунковий RPO — до 24 годин за умови успішних щоденних backup; пропуски
збільшують його. Це не PITR і не offsite disaster recovery: локальний диск не захищає
від втрати хоста. Виміряний RTO та розмір — у `RESTORE-DRILL.md`.

Dev `bootstrap`/seed і публічний bootstrap-пароль — лише для курсового Compose.
Production deployment не повинен автоматично запускати seed: міграції виконуються
окремим job, credentials/TLS постачаються сховищем. Backup/drill не копіюють ролі,
tablespaces чи секрети — це логічний дамп однієї бази, не повний backup кластера.

## Конкурентність

HW-14 додає `checkout` у `src/checkout.ts`, чергу `jobs` і `users.balance_cents`
міграцією `CheckoutQueue1790110000000`. `synchronize` залишається `false`.
Це data-layer операція; старий демонстраційний HTTP API із HW-1 не переведений
на PostgreSQL. Демо викликають саме транзакційний checkout, без HTTP і без черги
на рівні застосунку: усі 50 Promise запускаються одразу, очікування в пулі БД допустиме.

Обрано atomic UPDATE, а не попередній SELECT FOR UPDATE: для одного товару
`UPDATE ... SET stock = stock - quantity WHERE stock >= quantity RETURNING price_cents`
одночасно перевіряє залишок, блокує рядок і повертає актуальну ціну. Баланс
списується аналогічно з умовою достатності коштів. В одному `db.transaction`
через один manager виконуються обидва UPDATE, INSERT order, items і job.
UPDATE і INSERT order використовують QueryBuilder із `.returning()` та `result.raw`,
без залежності від різних форм результату `manager.query()` для цих операцій.
Будь-яка помилка відкочує все; гроші обчислюються через BigInt, без float.
Для майбутнього multi-product checkout потрібен однаковий порядок блокування товарів.

Результати реального прогону PostgreSQL 17 (2026-09-23, пул 10):

| Перевірка | Результат |
| --- | --- |
| `demo:race` | 50 спроб, 10 успішних, stock 0, від'ємних залишків 0 |
| Атомарність гонки | 10 orders, 10 items, 10 jobs; баланс 1000000000 → 999999000 |
| `demo:workers` | 12 задач, 3 воркери по 4; двічі 0; 458.1 мс проти послідовних 1200 мс |
| `demo:retry` | 1 повтор після 40001; баланс 1000 + 100 + 200 = 1300 |

Повторний acceptance-прогін у чистій копії без `node_modules`, `dist`, `.env`
і секретів, на новому Docker volume: `npm ci`, `tsc --noEmit`, міграції,
seed двічі й усі три демо пройшли. Workers: 447.0 мс; при пулі 2 — 665.5 мс.
Race при пулі 50 також дав рівно 10 успіхів. Перевірено 30 тестів без БД,
6 інтеграційних, down/up нової міграції та відсутність schema drift TypeORM.

Кожне демо створює власного UUID-користувача і тестовий товар, а після assertions
видаляє лише свої дані. Тому повторні запуски незалежні й не поповнюють stock
існуючих товарів. Покупець race має завідомо надлишковий баланс; нові користувачі
звичайного seed також отримують 1000000000 копійок. У реальних користувачів після
міграції баланс 0: міграція не вигадує кошти.

Воркер тримає `FOR UPDATE SKIP LOCKED` і транзакцію до завершення обробки;
`result`, `status=done` і `processed=processed+1` комітяться разом. Порожня вибірка
перевіряється окремим читанням pending: якщо задачі заблоковані іншими воркерами,
воркер чекає та пробує знову. Для цього використано `EXISTS (SELECT 1 ... LIMIT 1)`,
а не підрахунок усіх pending. Це drain-worker для поточної черги, не постійний daemon.
Міграція `ObservableJobProcessing1790550000000` дозволяє `processed >= 1` для done:
захист від повторної обробки забезпечує worker, а не CHECK. Негативний інтеграційний
тест навмисно встановлює `processed=2` і перевіряє, що метрика повторів дорівнює 1.
Обробка демо — імітація 100 мс та запис чека в БД. Гарантія одного committed
результату не поширюється автоматично на зовнішній SMTP/HTTP: для реальної відправки
потрібні ідемпотентний одержувач або outbox. Після rollback callback може виконатися знову.

Retry ловить **тільки 40001 (serialization failure) і 40P01 (deadlock)**: це
конфлікти транзакцій, для яких повтор із новими читаннями має сенс. Бізнес-відмови,
порушення constraints та мережеві помилки не повторюються — останні можуть мати
невідомий результат COMMIT. Повторюється весь `REPEATABLE READ` callback,
максимум 5 спроб, exponential backoff 10–500 мс із jitter. Демо бар'єром змушує
дві перші транзакції прочитати однаковий snapshot, тому 40001 не залежить від удачі.
Для workers/retry потрібно `DB_POOL_MAX >= 2` (типове значення 10).

`npm test` перевіряє retry-коди й ліміт спроб без БД.
`npm run test:concurrency` на мігрованій БД перевіряє rollback при нестачі коштів,
товару, помилці INSERT order/job, спільний баланс для різних товарів і повторне
підхоплення задачі після падіння воркера. Усі DB-команди використовують наявний
`scripts/with-secrets.sh dev`; нових env-файлів немає. Live Infisical не перевірений,
оскільки облікового запису ще немає; acceptance виконується через `SKIP_VAULT=1`.

Формат здачі: PR із гілки `hw-14`, посилання на PR у LMS.

## HW-13: entities та міграції

`src/entities/` містить усі чотири таблиці та двосторонні relations; `OrderItem` —
явна join-entity з кількістю й ціною на момент покупки. `synchronize: false`,
`migrationsRun: false`: тільки явний `npm run migrate` змінює схему.
Збірка виконується `tsc` з `emitDecoratorMetadata`; ORM CLI працює з `dist/data-source.js`.

У HW-12 гроші були `numeric` в основних одиницях. Відповідно до нової умови HW-13
вони представлені цілими копійками: `price_cents`, `total_cents`, `unit_price_cents`
типу PostgreSQL `bigint`. Тип зберігає початковий діапазон сум; у TypeScript він
має тип `string`, обчислення seed використовують `BigInt`, а агрегати повертаються
десятковими рядками. `number`/float-трансформерів для грошей немає.
Початкова міграція розрахована на порожню БД; це не in-place конвертація даних HW-12.

Міграцію `1789797879157-InitialMarketplace.ts` реально згенеровано командою:

```bash
npm run build
npm run migration:generate -- src/migrations/InitialMarketplace
npm run build
```

Це опис походження, а не команда повторного встановлення: готова міграція вже в репо.
Після рев'ю в up/down додано чотири PostgreSQL-індекси, які генератор не описує
повністю: UNIQUE lower(email), lower(name), covering user/date та partial pending.
У entities вони позначені `@Index(..., { synchronize: false })`, щоб генератор
не намагався переробляти їх; два звичайні FK-індекси описано через `@Index` із колонками.
`npm run check:indexes` звіряє ці чотири індекси з каталогом PostgreSQL: таблицю,
UNIQUE, вирази, порядок і напрям ключів, INCLUDE, предикат та валідність.
`npm run migration:generate` запускає цю перевірку перед генератором і зупиняється
при дрейфі; для порожньої БД перевірку пропущено. Прямий CLI TypeORM цієї перевірки
не має. Після міграцій запускайте `check:indexes`; при навмисній зміні індексів
оновлюйте міграцію та контракт у `src/index-contract.ts` разом.
Решта NOT NULL, CHECK, identity, timestamptz, FK і UNIQUE(order_id, product_id)
збережена зі схеми HW-12. down видаляє індекси, FK та таблиці у зворотному порядку.

### Політика видалення

`RESTRICT` на products → seller, orders → user, order_items → product захищає
посилання на користувачів і товари в історії. `CASCADE` на order_items → order
видаляє залежні позиції, коли дозволено видалити саме замовлення; позиції без
замовлення не мають сенсу. Бізнес-заборона видалення оплачених замовлень належить
майбутній транзакційній логіці, а не автоматичному ORM cascade-save.

### N+1: список замовлень із позиціями та товарами

Демо вмикає `logging: ['query']` і друкує весь SQL. Виміряно на детермінованому seed
(по дві позиції на замовлення):

| Кількість замовлень N | Наївно: 1 + N + 2N | leftJoinAndSelect |
| --- | --- | --- |
| 5 | 16 | 1 |
| 10 | 31 | 1 |

Лічильник скидається після ініціалізації з'єднання, перед кожним способом завантаження.
LIMIT застосовується до підзапиту ID замовлень, а не до рядків JOIN: усі позиції
залишаються в результаті. Демо перевіряє повну рівність графів і стабільність одного
SQL-запиту при збільшенні N; кешування вимкнене. `relationLoadStrategy: 'query'`
тут не використовується.

Розміри можна змінити: `NPLUS1_SIZES=2,7,10 npm run demo:nplus1`.
Для подвоєного набору: `NPLUS1_SIZES=10,20 npm run demo:nplus1`.
Потрібна БД із щонайменше найбільшим указаним числом замовлень: демо завершується
помилкою при нестачі, а не підміняє запитаний N фактичним розміром seed.

### Repository чи QueryBuilder

Repository використовуємо для простого пошуку, CRUD і завантаження entities за
відомими полями. QueryBuilder — коли потрібні явні JOIN, агрегати, GROUP BY або
контроль пагінації графа; звіт у `src/report.ts` групує сплачений/відвантажений
виторг за продавцем через `createQueryBuilder().getRawMany()`, що не виражається `find()`.
Виторг рахується з історичного `unit_price_cents`, не з поточної ціни товару.

### Infisical: основний шлях

У попередньому ДЗ використовували файлові секрети, тому Infisical додається тут.
Реальний проєкт Infisical користувач ще не створив: live-доступ не перевірений.
Шлях грейдера `SKIP_VAULT=1` перевіряється незалежно від сховища.

1. Встановіть [Infisical CLI](https://infisical.com/docs/cli/overview), створіть проєкт
   та оточення `dev`/`prod`. Додайте `DB_URL` без пароля і `DB_PASSWORD` у кожне
   оточення (для dev значення наведені у Grading; для prod — власна БД).
2. Виконайте `infisical login` або використайте machine-identity token.
3. Створіть локальний файл credentials:

```bash
mkdir -p .secrets
cp scripts/infisical.env.example .secrets/infisical.env
chmod 700 .secrets
chmod 600 .secrets/infisical.env
```

Вкажіть власний `INFISICAL_PROJECT_ID` у файлі; за потреби `INFISICAL_TOKEN`.
`.secrets/` виключена і з Git, і з Docker build context. У DataSource немає dotenv
та зашитих креденшелів: `validate(process.env)` перевіряє конфігурацію з обгортки.
ORM використовує пароль зі сховища; за відсутності `DB_PASSWORD` збережено
async callback для файлового секрету з ДЗ №11.

```bash
unset SKIP_VAULT
npm run build
npm run migrate
npm run seed
```

Усі шість DB-команд починаються з `bash scripts/with-secrets.sh dev ...`.
Для prod приклад: `bash scripts/with-secrets.sh prod npx typeorm migration:show -d dist/data-source.js`.
Обгортка виконує [infisical run](https://infisical.com/docs/cli/commands/run);
у CI `SKIP_VAULT=1` перевіряється після відокремлення аргументу dev і до читання credentials.

## HW-12: дата-шар та оптимізація

Архівний SQL-стенд: застосовуйте на окремому volume, не поверх ORM-схеми HW-13.

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
перезаписує. Нова БД ініціалізується окремим read-only bootstrap-секретом із
`db/db_password.example`. Реальний пароль після ротації зберігається у volume;
після видалення volume поверніть runtime secret до прикладу. Нових реальних env-файлів у git немає.
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
Початкова схема окремо забезпечує UNIQUE на `lower(email)` і містить індекси
`products.seller_id` та `order_items.product_id` для перевірок зовнішніх ключів.
q1 вибирає замовлення за березень 2026; q3 шукає товар за `lower(name)`.
Фактичні плани й час виконання: [OPTIMIZATIONS](db/OPTIMIZATIONS.md).
Схема й seed застосовуються один раз до порожньої БД; seed закінчується `VACUUM (ANALYZE)`.
Історичний `src/app.ts` із in-memory даними використовується тільки в unit-тестах; поточний Nest HTTP API (HW-16/18) працює з PostgreSQL, а `/db-health` перевіряє з'єднання з БД.
