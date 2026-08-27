# HW 05

JavaScript/Express API та PostgreSQL 17 запускаються одним Docker Compose
стеком. API має ендпойнти `GET /health` і `GET /users`.

## Запуск

Потрібні Docker Engine із Compose v2. Додаткові `.env` файли не потрібні.

```bash
docker compose up -d --build
curl http://localhost:3000/health
curl http://localhost:3000/users
```

Звичайна команда автоматично застосовує `docker-compose.override.yml`: код із
`src` підключається як bind mount, працює hot-reload, а порт `3000` доступний на
хості. Зупинка без видалення даних:

```bash
docker compose down
```

CI/production-конфігурація не потребує override та не містить bind mount:

```bash
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml config
```

## Перевірки

Healthcheck і non-root користувач:

```bash
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q api)"
docker build -t hw05-api .
docker run --rm --entrypoint id hw05-api -u
```

Остання команда має вивести UID `1000`, а не `0`.

Persistence Postgres перевірено так:

```bash
docker compose exec postgres psql -U app -d app -c \
  'CREATE TABLE IF NOT EXISTS persistence_check (id integer PRIMARY KEY);'
docker compose down
docker compose up -d
docker compose exec postgres psql -U app -d app -c '\dt persistence_check'
```

Таблиця залишається після `down`, оскільки дані зберігаються в іменованому
volume `postgres_data`. Видалити стек разом із даними можна лише явно:
`docker compose down -v`.

## Розміри образів

Образи збиралися та вимірювалися командами:

```bash
docker build -t hw05-api:multistage .
docker build -f Dockerfile.single -t hw05-api:single-stage .
docker images hw05-api --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'
```

| Образ                   |  Розмір |
| ----------------------- | ------: |
| `hw05-api:multistage`   |  250 MB |
| `hw05-api:single-stage` | 1.18 GB |

Multi-stage образ менший, бо фінальна стадія базується на `node:22-slim` і
містить лише production-залежності та скомпільований `dist`, тоді як одноетапний
образ містить повний базовий Node-образ, dev-залежності й вихідний код.
