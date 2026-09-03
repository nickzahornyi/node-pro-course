#!/bin/sh
set -eu

secret_file="$(dirname "$0")/secrets/db_password"
new_password="$(openssl rand -hex 24)"

docker compose exec -T db psql -v ON_ERROR_STOP=1 -U marketplace -d marketplace \
  -c "ALTER ROLE marketplace WITH PASSWORD '$new_password';"
printf '%s\n' "$new_password" > "$secret_file"
chmod 600 "$secret_file"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U marketplace -d marketplace \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'marketplace' AND pid <> pg_backend_pid();"

echo "Database password rotated; the application process was not restarted."
