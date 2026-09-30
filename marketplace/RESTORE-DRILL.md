# Restore drill — HW-15

Дата: **2026-09-28**, 06:39 UTC (09:39 Europe/Kyiv).
Середовище: локальний Docker Desktop; PostgreSQL 17, PgBouncer 1.25.2,
transaction mode, default_pool_size=5. Образ Postgres уже був завантажений.

## Артефакт та контрольні дані

`backup-2026-09-28T06-39-08.451Z-3214878e/marketplace-2026-09-28T06-39-08.451Z.dump`

Розмір: **17 478 байт**. Формат: `pg_dump -Fc`; `pg_restore --list` успішний.
Manifest містить SHA-256, counts і суми з **того самого exported snapshot**, що й дамп.
Backup destination: локальна тека `backups/` на хості, поза контейнером, gitignored.

| Контроль | До backup / після restore |
| --- | --- |
| users | 10 / 10 |
| products | 10 / 10 |
| orders | 10 / 10 |
| order_items | 20 / 20 |
| jobs | 0 / 0 |
| SUM(orders.total_cents) | 63750 / 63750 |
| SUM(users.balance_cents) | 10000000000 / 10000000000 |
| SUM(products.stock) | 1000 / 1000 |

## Вимірювання

| Прогін | Час pg_restore | RTO | Результат |
| --- | --- | --- | --- |
| 1, 06:39:32 UTC | 0.0963 секунди | **1.6745 секунди** | MATCH |
| 2, 06:39:34 UTC | 0.0835 секунди | **1.6096 секунди** | MATCH |
| Чиста копія, 06:41:02 UTC | 0.0654 секунди | **1.5733 секунди** | MATCH |

RTO вимірюється від запуску drill (пошук і checksum backup включені) до успішного
порівняння даних: створення volume/container, initdb і очікування TCP-ready,
pg_restore та контрольні SELECT. Cleanup відбувається після вимірювання.
Це **RTO локального restore-drill**, не production failover SLA: не враховує
виявлення аварії, рішення оператора, завантаження образу в холодному середовищі,
перемикання DNS/застосунку. Велика production-БД відновлюватиметься довше.

**RPO: до 24 годин** при успішному щоденному backup о 02:00 за `backup.cron`
(номінальний інтервал; snapshot робиться на початку backup). Пропущений/невдалий
backup збільшує реальний RPO до віку останнього успішного snapshot. Архівації WAL
і PITR немає. Cron-файл підготовлений, але не встановлений у crontab автоматично.

## Ізоляція та повторюваність

Обидва рази створено нові UUID-named container і volume; перед restore перевірено
нуль таблиць у public. Мережа контейнера `none`, опублікованих портів немає.
Використано `--no-owner --no-acl --single-transaction --exit-on-error`.
Після кожного прогону видалено лише його disposable container і volume; source DB
і backup збережено. Повторний запуск над тим самим дампом також дав MATCH.

Команди відтворення — у README → Grading. Детальні JSON-протоколи залишаються
біля дампу. Локальні артефакти не комітяться: майбутній перевіряльник створює власні.

Негативні перевірки (`npm run test:ops`): змінений count у manifest → ненульовий
exit із RESTORE MISMATCH; змінений байт дампу → checksum mismatch до створення
контейнера. Після успіхів і помилки відновлення список drill-volumes не змінився.
Через PgBouncer також пройшли 7 інтеграційних тестів HW-14, race 50/10, workers
без повторів і retry 40001 із фінальним балансом 1300.

Acceptance повторено з чистої копії без node_modules, dist, .env і secrets:
`docker compose up -d --wait` → backup → drill. API `/db-health` повернув 200.
Окремо перевірено ротацію спільного password/userlist: API PID не змінився,
підключення через PgBouncer відновилося без рестарту застосунку.
