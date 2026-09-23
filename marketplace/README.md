# Marketplace API contract

Для поточного ДЗ **HW-13 (TypeORM)** починайте з [Grading](#grading).
Усі npm/Compose-команди виконуються в `marketplace/` після клонування репозиторію.
Розділ HW-12 нижче збережено як окремий SQL-стенд попереднього завдання.

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
| `DB_URL` | так | PostgreSQL URL без пароля. ORM: сховище Infisical dev/prod → process.env або CI environment. Старий HTTP-застосунок: локальний `.env` / runtime environment Compose. |
| `DB_PASSWORD` | ні | Пароль ORM зі сховища Infisical або CI; якщо відсутній, ORM перечитує `DB_PASSWORD_FILE` на кожне з'єднання. |
| `DB_PASSWORD_FILE` | ні, `/run/secrets/db_password` | Шлях до файла з паролем БД |
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

Команда створює відсутній `secrets/db_password` із публічного dev-прикладу,
але не перезаписує наявний, зокрема після ротації. Compose передає конфігурацію
без `.env`. Прямий запуск профілю через Compose потребує вже підготовленого файла.

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

## Grading

`cd marketplace` — перша команда після клону репозиторію; усі команди нижче виконуються в цьому каталозі з `package.json`.

Потрібні Node.js 22+ і Docker Compose з підтримкою `--wait`.
Після клону перейдіть у каталог сервісу: `cd marketplace`.
Використовуйте чистий volume: **не запускайте db/schema.sql або db/seed.sql HW-12
перед ORM-міграцією**. Для ізоляції від попередніх ДЗ можна задати
`export COMPOSE_PROJECT_NAME=marketplace-hw14` перед командами нижче.
Порт 5432 має бути вільним; для іншого порту задайте `DB_PUBLISHED_PORT` і
той самий порт у `DB_URL`.

```bash
npm ci && npx tsc --noEmit
docker compose up -d --wait
export DB_URL=postgresql://marketplace@127.0.0.1:5432/marketplace DB_PASSWORD=marketplace-local-password
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

Очікуються `[X] InitialMarketplace…` і `[X] CheckoutQueue…`, а після обох seed — `10 users`, `10 products`,
`10 orders`, `20 order_items`. `migrate:revert` відкочує останню міграцію:
для HW-14 видаляє jobs і balance_cents, повторний revert видалить таблиці HW-13.
Виконуйте revert лише на тестовій БД: дані відкочених структур буде втрачено.
Грейдер не потребує `.env`, `.secrets/`, CLI Infisical або ручного створення secret.
База використовує публічний dev-пароль із `db/db_password.example`, змонтований
у Postgres як `POSTGRES_PASSWORD_FILE`. Усі мережеві підключення все одно проходять
парольну автентифікацію. HTTP-застосунок вмикається окремим профілем `api`.

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
воркер чекає та пробує знову. Це drain-worker для поточної черги, не постійний daemon.
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
Існуючі HTTP-обробники залишаються in-memory; `/db-health` перевіряє реальну БД.
